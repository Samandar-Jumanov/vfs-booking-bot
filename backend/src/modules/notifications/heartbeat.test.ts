/**
 * Tests for HeartbeatScheduler.
 * Uses jest fake timers so the interval never fires unless we advance time.
 */

// Mock telegram.bot BEFORE importing heartbeat so the module picks up the mock.
jest.mock('./telegram.bot', () => ({
  sendTelegram: jest.fn().mockResolvedValue(undefined),
}));

// Mock env so we can control TELEGRAM_BOT_TOKEN in each test.
jest.mock('@config/env', () => ({
  env: {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: '12345',
    HEARTBEAT_INTERVAL_MS: 20 * 60 * 1000,
  },
}));

import { HeartbeatScheduler } from './heartbeat';
import { sendTelegram } from './telegram.bot';

const mockSendTelegram = sendTelegram as jest.MockedFunction<typeof sendTelegram>;

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSendTelegram.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── 1. start() + stop() do not throw ─────────────────────────────────────

  it('start() and stop() do not throw', () => {
    const getCount = jest.fn().mockResolvedValue(5);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    expect(() => scheduler.start()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  // ── 2. start() is idempotent ──────────────────────────────────────────────

  it('start() is idempotent — calling twice does not create duplicate timers', async () => {
    const getCount = jest.fn().mockResolvedValue(3);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    scheduler.start();
    scheduler.start(); // second call must be a no-op

    jest.advanceTimersByTime(20 * 60 * 1000);
    // Flush the pending microtasks so fireNow's async work settles.
    await Promise.resolve();
    await Promise.resolve();

    // Should have fired exactly once (one timer)
    expect(mockSendTelegram).toHaveBeenCalledTimes(1);

    scheduler.stop();
  });

  // ── 3. fireNow() calls sendTelegram with correct message format ───────────

  it('fireNow() sends correct "no slots" message format', async () => {
    const getCount = jest.fn().mockResolvedValue(7);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    await scheduler.fireNow();

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    const msg: string = mockSendTelegram.mock.calls[0][0];
    // Must contain the watching prefix and accounts count
    expect(msg).toMatch(/Watching/);
    expect(msg).toMatch(/7 accounts active/);
    expect(msg).toMatch(/no slots/);
  });

  // ── 4. After recordCheck(false) + fireNow() → message includes "no slots" ─

  it('after recordCheck(false), fireNow() message contains "no slots"', async () => {
    const getCount = jest.fn().mockResolvedValue(2);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    scheduler.recordCheck(false);
    await scheduler.fireNow();

    const msg: string = mockSendTelegram.mock.calls[0][0];
    expect(msg).toContain('no slots');
    expect(msg).toMatch(/last check \d{2}:\d{2}/);
  });

  // ── 5. After recordCheck(true) + fireNow() → message includes booking ────

  it('after recordCheck(true), fireNow() message indicates booking in progress', async () => {
    const getCount = jest.fn().mockResolvedValue(4);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    scheduler.recordCheck(true);
    await scheduler.fireNow();

    const msg: string = mockSendTelegram.mock.calls[0][0];
    // Must reference slot found / booking in progress (not "no slots")
    expect(msg.toLowerCase()).toMatch(/slot found|booking in progress/);
    expect(msg).not.toContain('no slots');
  });

  // ── 6. getActiveCount callback is called during fireNow() ────────────────

  it('getActiveCount is called when fireNow() runs', async () => {
    const getCount = jest.fn().mockResolvedValue(10);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    await scheduler.fireNow();

    expect(getCount).toHaveBeenCalledTimes(1);
  });

  // ── 7. Timer interval fires fireNow automatically ─────────────────────────

  it('fires sendTelegram once when the interval elapses', async () => {
    const getCount = jest.fn().mockResolvedValue(1);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    scheduler.start();
    jest.advanceTimersByTime(20 * 60 * 1000);

    // Let the async queue drain
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendTelegram).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  // ── 8. stop() prevents further fires ─────────────────────────────────────

  it('stop() prevents further timer fires', async () => {
    const getCount = jest.fn().mockResolvedValue(1);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    scheduler.start();
    scheduler.stop();

    jest.advanceTimersByTime(60 * 60 * 1000); // advance 1 hour
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendTelegram).not.toHaveBeenCalled();
  });

  // ── 9. No TELEGRAM_BOT_TOKEN → console.info only, no sendTelegram call ───

  it('skips sendTelegram and logs to console when no TELEGRAM_BOT_TOKEN', async () => {
    // Temporarily override env mock for this test
    const envModule = require('@config/env');
    const originalToken = envModule.env.TELEGRAM_BOT_TOKEN;
    envModule.env.TELEGRAM_BOT_TOKEN = undefined;

    const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const getCount = jest.fn().mockResolvedValue(3);
    const scheduler = new HeartbeatScheduler(20 * 60 * 1000, getCount);

    await scheduler.fireNow();

    expect(mockSendTelegram).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/\[heartbeat\]/));

    consoleSpy.mockRestore();
    envModule.env.TELEGRAM_BOT_TOKEN = originalToken;
  });
});
