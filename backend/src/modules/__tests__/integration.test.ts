/**
 * Integration test suite for:
 *   - SmsActivateService  (unit, axios mocked)
 *   - MailsacService      (unit, axios mocked)
 *   - AccountPoolService  (unit, Prisma mocked)
 *   - Full registration flow (documented only — requires real credentials)
 */

// ---------------------------------------------------------------------------
// Module mocks — declared BEFORE any imports so jest.mock() hoisting works
// ---------------------------------------------------------------------------

// Mock axios globally
jest.mock('axios');

// Mock @prisma/client to prevent loading the generated client (huge bundle)
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(),
  BookingStatus: {
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    CANCELLED: 'CANCELLED',
  },
  EventType: {
    SLOT_DETECTED: 'SLOT_DETECTED',
    BOOKING_ATTEMPT: 'BOOKING_ATTEMPT',
    BOOKING_SUCCESS: 'BOOKING_SUCCESS',
    BOOKING_FAILED: 'BOOKING_FAILED',
    MONITOR_STARTED: 'MONITOR_STARTED',
  },
  Priority: {
    HIGH: 'HIGH',
    NORMAL: 'NORMAL',
  },
  AccountStatus: {
    ACTIVE: 'ACTIVE',
    BLOCKED: 'BLOCKED',
    COOLDOWN: 'COOLDOWN',
  },
}));

// Mock the database module so Prisma never tries to connect
jest.mock('@config/database', () => ({
  prisma: {
    vfsAccount: {
      updateMany: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    booking: {
      updateMany: jest.fn(),
    },
    log: {
      create: jest.fn(),
    },
    $queryRaw: jest.fn(),
  },
}));

// Mock env so services don't throw "not configured" for optional keys
jest.mock('@config/env', () => ({
  env: {
    SMS_ACTIVATE_API_KEY: 'test-sms-key',
    MAILSAC_API_KEY: 'test-mailsac-key',
    EMAIL_DOMAIN: 'mailsac.com',
    BOOKING_DRY_RUN: true,
    BOOKING_MAX_RETRIES: 3,
    REDIS_URL: 'redis://localhost:6379',
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:3000',
    PROFILE_ENCRYPTION_KEY: '0'.repeat(64),
  },
}));

// Mock @utils/retry's sleep so MailsacService polling doesn't actually wait
jest.mock('@utils/retry', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
}));

const emittedEvents: Array<{ event: string; data: unknown }> = [];
jest.mock('@modules/websocket/ws.server', () => ({
  emitToAll: jest.fn((event: string, data: unknown) => emittedEvents.push({ event, data })),
}));

jest.mock('@modules/notifications/notification.service', () => ({
  dispatchNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@modules/logs/logger', () => ({
  logEvent: jest.fn(),
}));

const redisMock = {
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
};
jest.mock('@config/redis', () => ({
  getRedis: jest.fn(() => redisMock),
}));

jest.mock('@modules/settings/settings.service', () => ({
  getSetting: jest.fn().mockResolvedValue(null),
}));

const submitSelector = 'button:has-text("Submit"), button:has-text("Book Appointment")';
const clickedSelectors: string[] = [];
const waitForSelectorMock = jest.fn(async (selector: string) => ({
  boundingBox: jest.fn().mockResolvedValue(null),
  click: jest.fn(async () => {
    clickedSelectors.push(selector);
  }),
}));

const pageMock = {
  url: jest.fn(() => 'https://visa.vfsglobal.com/uzb/en/lva/dashboard'),
  goto: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  screenshot: jest.fn().mockResolvedValue(undefined),
  waitForLoadState: jest.fn().mockResolvedValue(undefined),
  waitForResponse: jest.fn().mockRejectedValue(new Error('Timeout 30000ms exceeded')),
  waitForSelector: waitForSelectorMock,
  click: jest.fn(async (selector: string) => {
    clickedSelectors.push(selector);
  }),
  keyboard: { type: jest.fn().mockResolvedValue(undefined) },
  selectOption: jest.fn().mockResolvedValue(undefined),
  $: jest.fn().mockResolvedValue({}),
  getByText: jest.fn(() => ({
    first: jest.fn(() => ({
      click: jest.fn().mockResolvedValue(undefined),
    })),
  })),
  locator: jest.fn((selector: string) => {
    if (selector === 'body') {
      return { innerText: jest.fn().mockResolvedValue('Review your appointment details') };
    }
    if (
      selector.includes('Start New Booking') ||
      selector.includes('Tashkent') ||
      selector.includes('mat-calendar') ||
      selector.includes('.mat-calendar')
    ) {
      return {
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn(() => ({
          count: jest.fn().mockResolvedValue(1),
          click: jest.fn().mockResolvedValue(undefined),
          waitFor: jest.fn().mockResolvedValue(undefined),
        })),
      };
    }
    if (selector.includes('slotTimeButton') || selector.includes('mat-radio-button') || selector.includes('.time-slot-option')) {
      return {
        count: jest.fn().mockResolvedValue(1),
        nth: jest.fn(() => ({
          innerText: jest.fn().mockResolvedValue('09:00'),
          isEnabled: jest.fn().mockResolvedValue(true),
          click: jest.fn().mockResolvedValue(undefined),
        })),
      };
    }
    if (selector.includes('td[data-date')) {
      return {
        count: jest.fn().mockResolvedValue(1),
        first: jest.fn(() => ({ click: jest.fn().mockResolvedValue(undefined) })),
      };
    }
    return {
      count: jest.fn().mockResolvedValue(0),
      first: jest.fn(() => ({
        count: jest.fn().mockResolvedValue(0),
        innerText: jest.fn().mockResolvedValue(''),
        click: jest.fn().mockResolvedValue(undefined),
      })),
      nth: jest.fn(() => ({
        innerText: jest.fn().mockResolvedValue(''),
        isEnabled: jest.fn().mockResolvedValue(false),
        click: jest.fn().mockResolvedValue(undefined),
      })),
      innerText: jest.fn().mockResolvedValue(''),
    };
  }),
};

jest.mock('@modules/monitor/playwright.fetch', () => ({
  getReusableContextFor: jest.fn(() => ({
    newPage: jest.fn().mockResolvedValue(pageMock),
  })),
}));

jest.mock('@modules/profiles/profiles.service', () => ({
  getProfileForBooking: jest.fn().mockResolvedValue({
    id: 'profile-1',
    fullName: 'Jane Doe',
    passportNumber: 'AA1234567',
    dob: '1990-01-01',
    passportExpiry: new Date('2030-01-01T00:00:00.000Z'),
    nationality: 'UZB',
    email: 'jane@example.com',
    phone: '+998901234567',
  }),
}));

// ---------------------------------------------------------------------------
// Now import under-test modules (after mocks are registered)
// ---------------------------------------------------------------------------

import axios from 'axios';
import { SmsActivateService } from '@modules/phone/smsActivate.service';
import { MailsacService } from '@modules/email/mailsac.service';
import { AccountPoolService } from '@modules/accounts/accountPool.service';
import { processBookingJob } from '@modules/booking/booking.worker';
import { prisma } from '@config/database';

// Simple any-cast helpers — avoids loading Prisma generated types in the test
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedAxios = axios as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockedPrisma = prisma as any;

// ---------------------------------------------------------------------------
// A — SmsActivateService unit tests
// ---------------------------------------------------------------------------

describe('SmsActivateService', () => {
  let service: SmsActivateService;

  beforeEach(() => {
    service = new SmsActivateService();
    jest.clearAllMocks();
  });

  // ── buyNumber ──────────────────────────────────────────────────────────────

  describe('buyNumber', () => {
    it('returns { id, number } when the API responds ACCESS_NUMBER:<id>:<phone>', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({
        data: 'ACCESS_NUMBER:123:+79001234567',
      });

      const result = await service.buyNumber('vfs', '0');

      expect(result).toEqual({ id: '123', number: '+79001234567' });
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      const callArgs = mockedAxios.get.mock.calls[0];
      expect(callArgs[1].params.action).toBe('getNumber');
      expect(callArgs[1].params.service).toBe('vfs');
      expect(callArgs[1].params.country).toBe('0');
    });

    it('throws when the API returns NO_NUMBERS', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'NO_NUMBERS' });

      await expect(service.buyNumber('vfs', '0')).rejects.toThrow(
        'SMS-Activate getNumber failed: NO_NUMBERS',
      );
    });

    it('throws when the API returns an unexpected NO_ prefix response', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'NO_BALANCE' });

      await expect(service.buyNumber('vfs', '0')).rejects.toThrow(
        'SMS-Activate getNumber failed: NO_BALANCE',
      );
    });

    it('throws when the response does not have exactly 3 colon-separated parts', async () => {
      mockedAxios.get = jest
        .fn()
        .mockResolvedValueOnce({ data: 'ACCESS_NUMBER:only_two_parts' });

      await expect(service.buyNumber('vfs', '0')).rejects.toThrow(
        'unexpected format',
      );
    });
  });

  // ── getOtp ─────────────────────────────────────────────────────────────────

  describe('getOtp', () => {
    it('returns the OTP code when the API responds STATUS_OK:<code>', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'STATUS_OK:5678' });

      const code = await service.getOtp('activation-abc');

      expect(code).toBe('5678');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      const callArgs = mockedAxios.get.mock.calls[0];
      expect(callArgs[1].params.action).toBe('getStatus');
      expect(callArgs[1].params.id).toBe('activation-abc');
    });

    it('throws after timeout when only STATUS_WAIT_CODE is received', async () => {
      // Strategy: the first call to Date.now() establishes `deadline`.
      // Every subsequent call must return a value >= deadline so the while-loop
      // exits immediately without any polling.
      //
      // deadline = firstCall + POLL_TIMEOUT_MS (180 000 ms)
      // We make the second call return firstCall + POLL_TIMEOUT_MS + 1, which
      // is > deadline, so the loop exits and throws the timeout error.
      const base = 1_000_000;
      let invocations = 0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        invocations++;
        // First call: used for `const deadline = Date.now() + POLL_TIMEOUT_MS`
        // Return base so deadline = base + 180_000.
        // Second+ calls: used for `while (Date.now() < deadline)` checks.
        // Return base + 180_001 so the loop never runs.
        return invocations === 1 ? base : base + 180_001;
      });

      // Return STATUS_WAIT_CODE (no STATUS_OK will ever arrive)
      mockedAxios.get = jest.fn().mockResolvedValue({ data: 'STATUS_WAIT_CODE' });

      await expect(service.getOtp('activation-timeout')).rejects.toThrow(
        /timed out after 180s for activation ID activation-timeout/,
      );

      dateSpy.mockRestore();
    }, 10_000);

    it('throws immediately on STATUS_CANCEL', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'STATUS_CANCEL' });

      await expect(service.getOtp('activation-cancel')).rejects.toThrow(
        'SMS-Activate getStatus failed: STATUS_CANCEL',
      );
    });
  });

  // ── releaseNumber ──────────────────────────────────────────────────────────

  describe('releaseNumber', () => {
    it('calls the API with action=setStatus and status=8', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'ACCESS_CANCEL' });

      await service.releaseNumber('activation-xyz');

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      const callArgs = mockedAxios.get.mock.calls[0];
      expect(callArgs[1].params.action).toBe('setStatus');
      expect(callArgs[1].params.id).toBe('activation-xyz');
      expect(callArgs[1].params.status).toBe(8);
    });

    it('does not throw when the API returns ACCESS_CANCEL', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'ACCESS_CANCEL' });

      await expect(service.releaseNumber('activation-ok')).resolves.toBeUndefined();
    });

    it('throws when the API returns an ERROR_ response', async () => {
      mockedAxios.get = jest.fn().mockResolvedValueOnce({ data: 'ERROR_SQL' });

      await expect(service.releaseNumber('activation-err')).rejects.toThrow(
        'SMS-Activate releaseNumber failed: ERROR_SQL',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// B — MailsacService unit tests
// ---------------------------------------------------------------------------

describe('MailsacService', () => {
  let service: MailsacService;

  beforeEach(() => {
    service = new MailsacService();
    jest.clearAllMocks();
  });

  // ── waitForOtp ─────────────────────────────────────────────────────────────

  describe('waitForOtp', () => {
    it('returns OTP extracted from a labelled message body on the first poll', async () => {
      const address = 'test@mailsac.com';
      const messageId = 'msg-001';
      const futureTimestamp = new Date(Date.now() + 60_000).toISOString();

      // First GET: list messages endpoint
      mockedAxios.get = jest
        .fn()
        .mockResolvedValueOnce({
          data: [{ _id: messageId, received: futureTimestamp }],
        })
        // Second GET: fetch individual message text
        .mockResolvedValueOnce({ data: 'Your verification code is 4321' });

      const otp = await service.waitForOtp(address, 30_000);

      expect(otp).toBe('4321');
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('extracts OTP when a standalone digit sequence appears in the body', async () => {
      const address = 'user@mailsac.com';
      const messageId = 'msg-002';
      const futureTimestamp = new Date(Date.now() + 60_000).toISOString();

      mockedAxios.get = jest
        .fn()
        .mockResolvedValueOnce({
          data: [{ _id: messageId, received: futureTimestamp }],
        })
        .mockResolvedValueOnce({ data: 'Welcome! 7890 is your one-time PIN.' });

      const otp = await service.waitForOtp(address, 30_000);
      expect(otp).toBe('7890');
    });

    it('throws after timeout when no messages arrive', async () => {
      // Use Date.now spy so the deadline looks expired on the very first check
      // inside the while loop, preventing any iterative polling loop.
      const start = Date.now();
      // Return a deadline that is already elapsed: start itself means
      // Date.now() >= deadline immediately after the first listMessages call.
      let callCount = 0;
      const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
        // First call (computing deadline): return start
        // All subsequent calls (loop check): return start + timeoutMs + 1
        callCount++;
        return callCount === 1 ? start : start + 50 + 1;
      });

      mockedAxios.get = jest.fn().mockResolvedValue({ data: [] });

      await expect(service.waitForOtp('nobody@mailsac.com', 50)).rejects.toThrow(
        /waitForOtp timed out/,
      );

      dateSpy.mockRestore();
    });

    it('throws immediately for an invalid email address (no @)', async () => {
      await expect(service.waitForOtp('not-an-email', 10_000)).rejects.toThrow(
        'Invalid email address: "not-an-email"',
      );
    });

    it('throws immediately for an empty address', async () => {
      await expect(service.waitForOtp('', 10_000)).rejects.toThrow(
        'Invalid email address: ""',
      );
    });
  });

  // ── deleteMessages ─────────────────────────────────────────────────────────

  describe('deleteMessages', () => {
    it('calls the DELETE endpoint with the URL-encoded address', async () => {
      mockedAxios.delete = jest.fn().mockResolvedValueOnce({ data: {} });

      await service.deleteMessages('cleanup@mailsac.com');

      expect(mockedAxios.delete).toHaveBeenCalledTimes(1);
      const url: string = mockedAxios.delete.mock.calls[0][0];
      expect(url).toContain('cleanup%40mailsac.com');
      expect(url).toContain('/messages');
    });

    it('passes the Mailsac-Key auth header', async () => {
      mockedAxios.delete = jest.fn().mockResolvedValueOnce({ data: {} });

      await service.deleteMessages('hdr@mailsac.com');

      const opts = mockedAxios.delete.mock.calls[0][1];
      expect(opts.headers).toHaveProperty('Mailsac-Key', 'test-mailsac-key');
    });

    it('throws immediately for an invalid address', async () => {
      await expect(service.deleteMessages('not-valid')).rejects.toThrow(
        'Invalid email address: "not-valid"',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// C — AccountPoolService unit tests
// ---------------------------------------------------------------------------

describe('AccountPoolService', () => {
  let service: AccountPoolService;

  // Minimal VfsAccount fixture
  const activeAccount = {
    id: 'acc-001',
    email: 'active@mailsac.com',
    encryptedPassword: 'enc-pw',
    phone: '+1234567890',
    status: 'ACTIVE',
    lastUsedAt: null,
    cooldownUntil: null,
    profileIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    service = new AccountPoolService();
    jest.clearAllMocks();
  });

  // ── getAvailableAccount ────────────────────────────────────────────────────

  describe('getAvailableAccount', () => {
    it('returns the ACTIVE account selected by the raw UPDATE … RETURNING query', async () => {
      mockedPrisma.vfsAccount.updateMany.mockResolvedValueOnce({ count: 0 });
      mockedPrisma.$queryRaw.mockResolvedValueOnce([activeAccount]);

      const result = await service.getAvailableAccount();

      expect(result).toEqual(activeAccount);
      // Batch reset of expired COOLDOWN records must run first
      expect(mockedPrisma.vfsAccount.updateMany).toHaveBeenCalledTimes(1);
      // Atomic select + stamp query
      expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('throws when no ACTIVE accounts are available', async () => {
      mockedPrisma.vfsAccount.updateMany.mockResolvedValueOnce({ count: 0 });
      mockedPrisma.$queryRaw.mockResolvedValueOnce([]);

      await expect(service.getAvailableAccount()).rejects.toThrow(
        'No ACTIVE VFS accounts are currently available.',
      );
    });

    it('resets expired COOLDOWN accounts before the main query', async () => {
      mockedPrisma.vfsAccount.updateMany.mockResolvedValueOnce({ count: 1 });
      mockedPrisma.$queryRaw.mockResolvedValueOnce([activeAccount]);

      await service.getAvailableAccount();

      const updateManyCall = mockedPrisma.vfsAccount.updateMany.mock.calls[0][0];
      // The updateMany WHERE clause must target COOLDOWN status
      expect(updateManyCall?.where?.status).toBe('COOLDOWN');
      // And reset to ACTIVE
      expect(updateManyCall?.data?.status).toBe('ACTIVE');
    });
  });

  // ── markBlocked ────────────────────────────────────────────────────────────

  describe('markBlocked', () => {
    it('updates status to BLOCKED and clears cooldownUntil', async () => {
      mockedPrisma.vfsAccount.update.mockResolvedValueOnce({
        ...activeAccount,
        status: 'BLOCKED',
      });

      await service.markBlocked('acc-001');

      expect(mockedPrisma.vfsAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-001' },
        data: { status: 'BLOCKED', cooldownUntil: null },
      });
    });
  });

  // ── markCooldown ───────────────────────────────────────────────────────────

  describe('markCooldown', () => {
    it('sets status to COOLDOWN and computes cooldownUntil = now + minutes', async () => {
      mockedPrisma.vfsAccount.update.mockResolvedValueOnce({
        ...activeAccount,
        status: 'COOLDOWN',
      });

      const before = Date.now();
      await service.markCooldown('acc-001', 30);
      const after = Date.now();

      expect(mockedPrisma.vfsAccount.update).toHaveBeenCalledTimes(1);

      const updateCall = mockedPrisma.vfsAccount.update.mock.calls[0][0];
      expect(updateCall.where).toEqual({ id: 'acc-001' });
      expect(updateCall.data.status).toBe('COOLDOWN');

      const cooldownUntil: Date = updateCall.data.cooldownUntil;
      const expectedMin = before + 30 * 60 * 1_000;
      const expectedMax = after + 30 * 60 * 1_000;
      expect(cooldownUntil.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(cooldownUntil.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });

  // ── linkToProfile ──────────────────────────────────────────────────────────

  describe('linkToProfile', () => {
    it('pushes the profileId when it is not already present', async () => {
      mockedPrisma.vfsAccount.findUnique.mockResolvedValueOnce({
        profileIds: ['existing-profile'],
      });

      mockedPrisma.vfsAccount.update.mockResolvedValueOnce({
        ...activeAccount,
        profileIds: ['existing-profile', 'new-profile'],
      });

      await service.linkToProfile('acc-001', 'new-profile');

      expect(mockedPrisma.vfsAccount.update).toHaveBeenCalledWith({
        where: { id: 'acc-001' },
        data: { profileIds: { push: 'new-profile' } },
      });
    });

    it('does not call update when the profileId is already linked (no duplicate)', async () => {
      mockedPrisma.vfsAccount.findUnique.mockResolvedValueOnce({
        profileIds: ['already-linked'],
      });

      await service.linkToProfile('acc-001', 'already-linked');

      expect(mockedPrisma.vfsAccount.update).not.toHaveBeenCalled();
    });

    it('throws when the account does not exist', async () => {
      mockedPrisma.vfsAccount.findUnique.mockResolvedValueOnce(null);

      await expect(service.linkToProfile('nonexistent-id', 'prof-1')).rejects.toThrow(
        'VfsAccount with id "nonexistent-id" not found.',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// D — Full integration smoke test (documented only — do NOT execute)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// D - Booking dry-run integration
// ---------------------------------------------------------------------------

describe('Booking worker dry-run path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emittedEvents.length = 0;
    clickedSelectors.length = 0;
    redisMock.set.mockResolvedValue('OK');
  });

  it('reaches review screenshot, emits BOOKING_DRY_RUN_OK, and does not submit', async () => {
    mockedPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

    const result = await processBookingJob({
      id: 'job-1',
      attemptsMade: 0,
      data: {
        profileId: 'profile-1',
        sourceCountry: 'uzbekistan',
        destination: 'lva',
        visaType: 'SCH',
        slot: {
          date: '2026-06-01',
          time: '09:00',
          destination: 'lva',
          visaType: 'SCH',
        },
      },
    } as any);

    expect(result).toMatchObject({ success: true, dryRun: true });
    expect(pageMock.screenshot).toHaveBeenCalledTimes(1);
    expect(emittedEvents.some((e) => e.event === 'BOOKING_DRY_RUN_OK')).toBe(true);
    expect(clickedSelectors).not.toContain(submitSelector);
  });
});

// ---------------------------------------------------------------------------
// E - Full integration smoke test (documented only - do NOT execute)
// ---------------------------------------------------------------------------

// describe('Full registration flow (requires real credentials — run manually)', () => {
//   /**
//    * Pre-requisites:
//    *   - Real SMS_ACTIVATE_API_KEY in .env
//    *   - Real MAILSAC_API_KEY in .env
//    *   - Live Postgres DB with VfsAccount table
//    *   - VFS Global registration endpoint accessible
//    *
//    * Steps:
//    *   1. buyNumber → get { id, number }
//    *        const { id: activationId, number: phoneNumber } =
//    *          await smsActivateService.buyNumber('vfs', '0');
//    *
//    *   2. deleteMessages on the temp email address to clear any stale messages
//    *        const email = `temp_${uuidv4()}@mailsac.com`;
//    *        await mailsacService.deleteMessages(email);
//    *
//    *   3. registerVfsAccount() → returns { accountId, email, phone }
//    *        const result = await registerVfsAccount();
//    *        expect(result).toMatchObject({
//    *          accountId: expect.any(String),
//    *          email: expect.stringContaining('@'),
//    *          phone: expect.any(String),
//    *        });
//    *
//    *   4. accountPoolService.getAvailableAccount() → returns the new account
//    *        const account = await accountPoolService.getAvailableAccount();
//    *        expect(account.id).toBe(result.accountId);
//    *        expect(account.status).toBe('ACTIVE');
//    *
//    *   5. accountPoolService.markCooldown(accountId, 30)
//    *        await accountPoolService.markCooldown(result.accountId, 30);
//    *
//    *   6. accountPoolService.getAvailableAccount() → should skip cooldown account
//    *        // If no other ACTIVE accounts exist this should throw:
//    *        await expect(accountPoolService.getAvailableAccount())
//    *          .rejects.toThrow('No ACTIVE VFS accounts are currently available.');
//    *        // Or if other accounts exist, the returned account must differ:
//    *        // const next = await accountPoolService.getAvailableAccount();
//    *        // expect(next.id).not.toBe(result.accountId);
//    */
// });
