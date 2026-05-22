import { prisma } from '@config/database';
import { encrypt, decrypt } from '@utils/crypto';
import { AppError } from '@middleware/errorHandler';
import { EventType, LogLevel, Prisma, Priority } from '@prisma/client';
import { env } from '@config/env';
import { logEvent } from '@modules/logs/logger';
import { sendTelegram } from '@modules/notifications/telegram.bot';
import { CreateProfileDto, OnboardProfileDto, UpdateProfileDto } from './profiles.schema';
import { randomBytes } from 'crypto';

const STATUS_TOKEN_BYTES = 8;
const STATUS_TOKEN_LENGTH = 10;

export function generateStatusToken() {
  return randomBytes(STATUS_TOKEN_BYTES).toString('base64url').slice(0, STATUS_TOKEN_LENGTH);
}

function encryptProfile(data: { passportNumber: string; dob: string }) {
  return {
    passportNumberEnc: encrypt(data.passportNumber),
    dobEnc: encrypt(data.dob),
  };
}

function decryptProfile(raw: { passportNumberEnc: string; dobEnc: string }) {
  return {
    passportNumber: decrypt(raw.passportNumberEnc),
    dob: decrypt(raw.dobEnc),
  };
}

async function getLinkedAccountsByProfile(profileIds: string[]) {
  const result = new Map<string, Array<{ id: string; email: string; status: string; lastUsedAt: Date | null }>>();
  if (profileIds.length === 0) return result;

  const accounts = await prisma.vfsAccount.findMany({
    where: { profileIds: { hasSome: profileIds } },
    select: { id: true, email: true, status: true, lastUsedAt: true, profileIds: true },
    orderBy: { createdAt: 'desc' },
  });

  for (const account of accounts) {
    for (const profileId of account.profileIds) {
      if (!profileIds.includes(profileId)) continue;
      const linked = result.get(profileId) ?? [];
      linked.push({
        id: account.id,
        email: account.email,
        status: account.status,
        lastUsedAt: account.lastUsedAt,
      });
      result.set(profileId, linked);
    }
  }

  return result;
}

export async function createProfile(dto: CreateProfileDto) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.profile.create({ data: buildProfileCreateData(dto) });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray(err.meta?.target) &&
        err.meta.target.includes('statusToken')
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new AppError(500, 'Could not allocate profile status token', 'TOKEN_COLLISION');
}

export async function createOnboardProfile(dto: OnboardProfileDto) {
  const createDto: CreateProfileDto = {
    fullName: dto.fullName,
    passportNumber: dto.passportNumber,
    dob: dto.dob,
    passportExpiry: dto.passportExpiry,
    nationality: dto.nationality,
    email: dto.email,
    phone: dto.phone,
    gender: dto.gender,
    passportIssueDate: dto.passportIssueDate,
    priority: 'NORMAL',
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const profile = await prisma.profile.create({
        data: {
          ...buildProfileCreateData(createDto),
          // Public onboarding uses inactive + NORMAL as the pending-payment state.
          // Operators activate the profile after payment is collected.
          isActive: false,
          priority: Priority.NORMAL,
        },
      });
      const statusUrl = buildStatusUrl(profile.statusToken);
      await prisma.log.create({
        data: {
          level: LogLevel.INFO,
          eventType: EventType.MONITOR_STARTED,
          message: 'Customer onboarding pending payment',
          profileId: profile.id,
          destination: dto.destination,
          metadata: {
            source: 'public_onboard',
            status: 'PENDING_PAYMENT',
            preferredStartDate: dto.preferredStartDate,
            preferredEndDate: dto.preferredEndDate,
            paymentMethod: dto.paymentMethod,
            statusUrl,
          },
        },
      });
      await sendOperatorOnboardingAlert(dto, profile.statusToken, statusUrl);
      return {
        id: profile.id,
        statusToken: profile.statusToken,
        statusUrl,
      };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray(err.meta?.target) &&
        err.meta.target.includes('statusToken')
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new AppError(500, 'Could not allocate profile status token', 'TOKEN_COLLISION');
}

export function buildProfileCreateData(dto: CreateProfileDto) {
  const { passportNumber, dob, vfsPassword, ...rest } = dto;
  const { passportNumberEnc, dobEnc } = encryptProfile({ passportNumber, dob });

  return {
    ...rest,
    statusToken: generateStatusToken(),
    passportExpiry: new Date(dto.passportExpiry),
    passportIssueDate: dto.passportIssueDate ? new Date(dto.passportIssueDate) : null,
    priority: dto.priority as Priority,
    passportNumberEnc,
    dobEnc,
    ...(vfsPassword ? { vfsPasswordEnc: encrypt(vfsPassword) } : {}),
  };
}

function frontendBaseUrl() {
  return env.FRONTEND_URL.split(',')[0].trim().replace(/\/$/, '');
}

function buildStatusUrl(statusToken: string) {
  return `${frontendBaseUrl()}/status/${encodeURIComponent(statusToken)}`;
}

function escapeTelegramHtml(value?: string): string {
  return (value ?? 'N/A')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendOperatorOnboardingAlert(dto: OnboardProfileDto, statusToken: string, statusUrl: string) {
  const message = [
    '<b>New customer onboarding</b>',
    'Status: <b>PENDING_PAYMENT</b>',
    `Name: <b>${escapeTelegramHtml(dto.fullName)}</b>`,
    `Email: <code>${escapeTelegramHtml(dto.email)}</code>`,
    `Phone: <code>${escapeTelegramHtml(dto.phone)}</code>`,
    `Destination: <b>${escapeTelegramHtml(dto.destination)}</b>`,
    `Preferred dates: <b>${escapeTelegramHtml(dto.preferredStartDate)} to ${escapeTelegramHtml(dto.preferredEndDate)}</b>`,
    `Payment: <b>${escapeTelegramHtml(dto.paymentMethod)}</b>`,
    `Passport: <code>${escapeTelegramHtml(dto.passportNumber)}</code>`,
    `Status token: <code>${escapeTelegramHtml(statusToken)}</code>`,
  ].join('\n');

  await sendTelegram(message, {
    reply_markup: {
      inline_keyboard: [[{ text: 'Open status page', url: statusUrl }]],
    },
  }).catch((err: Error) => {
    logEvent('warn', EventType.BOOKING_FAILED, `Onboarding Telegram alert failed: ${err.message}`, {
      channel: 'telegram',
      email: dto.email,
      destination: dto.destination,
    });
  });
}

export async function getProfiles(opts: {
  cursor?: string;
  limit: number;
  search?: string;
  priority?: Priority;
}) {
  const where = {
    isActive: true,
    ...(opts.priority && { priority: opts.priority }),
    ...(opts.search && {
      fullName: { contains: opts.search, mode: 'insensitive' as const },
    }),
  };

  const profiles = await prisma.profile.findMany({
    where,
    take: opts.limit + 1,
    ...(opts.cursor && { cursor: { id: opts.cursor }, skip: 1 }),
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      statusToken: true,
      fullName: true,
      passportNumberEnc: true,
      dobEnc: true,
      passportExpiry: true,
      passportIssueDate: true,
      nationality: true,
      email: true,
      phone: true,
      gender: true,
      priority: true,
      isActive: true,
      createdAt: true,
    },
  });

  const hasMore = profiles.length > opts.limit;
  const items = hasMore ? profiles.slice(0, -1) : profiles;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  const accountMap = await getLinkedAccountsByProfile(items.map((p) => p.id));

  return {
    items: items.map((p) => ({
      ...p,
      ...decryptProfile(p),
      // Mask passport in list view: show only last 4 chars
      passportNumberMasked: `****${decrypt(p.passportNumberEnc).slice(-4)}`,
      linkedAccounts: accountMap.get(p.id) ?? [],
    })),
    nextCursor,
  };
}

export async function getProfileById(id: string) {
  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) throw new AppError(404, 'Profile not found', 'NOT_FOUND');
  const accountMap = await getLinkedAccountsByProfile([id]);
  return { ...profile, ...decryptProfile(profile), linkedAccounts: accountMap.get(id) ?? [] };
}

export async function updateProfile(id: string, dto: UpdateProfileDto) {
  const existing = await prisma.profile.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Profile not found', 'NOT_FOUND');

  const updates: Record<string, unknown> = { ...dto };

  if (dto.passportNumber) {
    updates.passportNumberEnc = encrypt(dto.passportNumber);
    delete updates.passportNumber;
  }
  if (dto.dob) {
    updates.dobEnc = encrypt(dto.dob);
    delete updates.dob;
  }
  if (dto.passportExpiry && dto.passportExpiry !== '') {
    updates.passportExpiry = new Date(dto.passportExpiry);
  }
  if (dto.passportIssueDate && dto.passportIssueDate !== '') {
    updates.passportIssueDate = new Date(dto.passportIssueDate);
  } else if (dto.passportIssueDate === '') {
    updates.passportIssueDate = null;
  }
  if (dto.vfsPassword) {
    updates.vfsPasswordEnc = encrypt(dto.vfsPassword);
    delete updates.vfsPassword;
  }

  return prisma.profile.update({ where: { id }, data: updates });
}

export async function deleteProfile(id: string) {
  const existing = await prisma.profile.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'Profile not found', 'NOT_FOUND');
  // Soft delete
  return prisma.profile.update({ where: { id }, data: { isActive: false } });
}

/** For use by automation engine — returns fully decrypted profile */
export async function getProfileForBooking(id: string) {
  const profile = await prisma.profile.findUnique({ where: { id, isActive: true } });
  if (!profile) throw new AppError(404, 'Profile not found or inactive', 'NOT_FOUND');
  return {
    ...profile,
    passportNumber: decrypt(profile.passportNumberEnc),
    dob: decrypt(profile.dobEnc),
    vfsPassword: profile.vfsPasswordEnc ? decrypt(profile.vfsPasswordEnc) : '',
  };
}

export async function setProfileAccounts(profileId: string, accountIds: string[]) {
  const profile = await prisma.profile.findUnique({ where: { id: profileId }, select: { id: true } });
  if (!profile) throw new AppError(404, 'Profile not found', 'NOT_FOUND');

  const uniqueAccountIds = Array.from(new Set(accountIds));
  if (uniqueAccountIds.length > 0) {
    const existingCount = await prisma.vfsAccount.count({ where: { id: { in: uniqueAccountIds } } });
    if (existingCount !== uniqueAccountIds.length) {
      throw new AppError(400, 'One or more VFS accounts do not exist', 'INVALID_ACCOUNT_IDS');
    }
  }

  await prisma.$transaction(async (tx) => {
    const linked = await tx.vfsAccount.findMany({
      where: { profileIds: { has: profileId } },
      select: { id: true, profileIds: true },
    });

    for (const account of linked) {
      if (uniqueAccountIds.includes(account.id)) continue;
      await tx.vfsAccount.update({
        where: { id: account.id },
        data: { profileIds: account.profileIds.filter((id) => id !== profileId) },
      });
    }

    const linkedIds = new Set(linked.map((account) => account.id));
    for (const accountId of uniqueAccountIds) {
      if (linkedIds.has(accountId)) continue;
      const account = await tx.vfsAccount.findUnique({
        where: { id: accountId },
        select: { profileIds: true },
      });
      if (!account) continue;
      await tx.vfsAccount.update({
        where: { id: accountId },
        data: { profileIds: [...account.profileIds.filter((id) => id !== profileId), profileId] },
      });
    }
  });

  return getProfileById(profileId);
}
