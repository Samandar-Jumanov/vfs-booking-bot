import { prisma } from '@config/database';
import { encrypt, decrypt } from '@utils/crypto';
import { AppError } from '@middleware/errorHandler';
import { Priority } from '@prisma/client';
import { CreateProfileDto, UpdateProfileDto } from './profiles.schema';

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

export async function createProfile(dto: CreateProfileDto) {
  const { passportNumber, dob, vfsPassword, ...rest } = dto;
  const { passportNumberEnc, dobEnc } = encryptProfile({ passportNumber, dob });

  return prisma.profile.create({
    data: {
      ...rest,
      passportExpiry: new Date(dto.passportExpiry),
      passportIssueDate: dto.passportIssueDate ? new Date(dto.passportIssueDate) : null,
      priority: dto.priority as Priority,
      passportNumberEnc,
      dobEnc,
      ...(vfsPassword ? { vfsPasswordEnc: encrypt(vfsPassword) } : {}),
    },
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

  return {
    items: items.map((p) => ({
      ...p,
      ...decryptProfile(p),
      // Mask passport in list view: show only last 4 chars
      passportNumberMasked: `****${decrypt(p.passportNumberEnc).slice(-4)}`,
    })),
    nextCursor,
  };
}

export async function getProfileById(id: string) {
  const profile = await prisma.profile.findUnique({ where: { id } });
  if (!profile) throw new AppError(404, 'Profile not found', 'NOT_FOUND');
  return { ...profile, ...decryptProfile(profile) };
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
