/**
 * Turnstile in-browser handler.
 *
 * VFS Cloudflare Turnstile is bound to the requesting browser's fingerprint+IP.
 * External-solver tokens (2Captcha / CapSolver) get REJECTED by VFS server-side
 * (proven 2026-05-09 with both providers). To pass Turnstile in production we
 * must solve it inside our own Playwright Chrome that's making the request.
 *
 * Three-tier strategy:
 *   1. AUTO-PASS — modern stealth Playwright + warmed session often makes
 *      Turnstile auto-grant without user interaction (~30-50% of the time
 *      depending on fingerprint quality).
 *   2. CAPSOLVER (token-only) — request a token using our session URL, attempt
 *      to inject into the page. May work; may be rejected.
 *   3. OPERATOR ESCALATION — pause the flow, save full state (URL, screenshot,
 *      cookies), notify operator via Telegram. Operator clicks the captcha in
 *      a remote Chrome / VNC, then signals "continue" → bot picks up cookies
 *      and proceeds.
 *
 * Each handler returns one of:
 *   - { status: 'passed', token?: string }
 *   - { status: 'failed', reason: string }
 */
import type { Page } from 'rebrowser-playwright';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { logEvent } from '@modules/logs/logger';
import { EventType } from '@prisma/client';
import { emitToAll } from '@modules/websocket/ws.server';

const VFS_TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '0x4AAAAAABhlz7Ei4byodYjs';
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY || '';

export interface TurnstileResult {
  status: 'passed' | 'failed' | 'paused-for-operator';
  token?: string;
  reason?: string;
  screenshotPath?: string;
}

/**
 * Detect whether the page currently shows a Turnstile challenge.
 * Returns true if a Turnstile iframe is present and the response input is empty.
 */
export async function detectTurnstile(page: Page): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const turnstileIframe = iframes.find((f) =>
        f.src?.includes('challenges.cloudflare.com') ||
        f.src?.includes('turnstile') ||
        f.title?.toLowerCase()?.includes('cloudflare') ||
        f.title?.toLowerCase()?.includes('challenge'),
      );
      const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
      return {
        hasIframe: !!turnstileIframe,
        iframeSrc: turnstileIframe?.src ?? null,
        responseValue: input?.value ?? '',
        responseSet: !!(input && input.value && input.value.length > 100),
      };
    });
    return result.hasIframe && !result.responseSet;
  } catch {
    return false;
  }
}

/**
 * Tier 1: AUTO-PASS. Wait up to N seconds for Turnstile to grant on its own.
 * Many Turnstile challenges auto-resolve within 5-15s when the request looks
 * legitimate (warmed session, realistic fingerprint).
 */
export async function tryAutoPass(page: Page, timeoutMs = 30_000): Promise<TurnstileResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillChallenging = await detectTurnstile(page);
    if (!stillChallenging) {
      // Either iframe gone OR response value populated → passed
      const token = await page.evaluate(() => {
        const i = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return i?.value ?? '';
      });
      logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] Auto-passed (token len=${token.length})`);
      return { status: 'passed', token };
    }
    await page.waitForTimeout(1000);
  }
  return { status: 'failed', reason: 'auto-pass timeout' };
}

/**
 * Tier 2: CAPSOLVER. Request a token from CapSolver and inject it.
 * Note: VFS may still reject the token if its Datadome / fingerprint check
 * matches our IP. Probable success rate: 0-30% based on 2026-05-09 testing.
 */
export async function tryCapsolver(page: Page, websiteURL: string): Promise<TurnstileResult> {
  if (!CAPSOLVER_KEY) {
    return { status: 'failed', reason: 'CAPSOLVER_API_KEY not configured' };
  }

  try {
    logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] Requesting CapSolver token...`);
    // Create task
    const create = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: CAPSOLVER_KEY,
      task: {
        type: 'AntiTurnstileTaskProxyLess',
        websiteURL,
        websiteKey: VFS_TURNSTILE_SITEKEY,
      },
    }, { timeout: 30_000 });

    if (create.data.errorId !== 0) {
      return { status: 'failed', reason: `createTask: ${create.data.errorDescription}` };
    }
    const taskId: string = create.data.taskId;

    // Poll for result (max 90s)
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: CAPSOLVER_KEY, taskId }, { timeout: 15_000 });
      if (r.data.errorId !== 0) {
        return { status: 'failed', reason: `getTaskResult: ${r.data.errorDescription}` };
      }
      if (r.data.status === 'ready') {
        const token = r.data.solution?.token;
        if (!token) return { status: 'failed', reason: 'no token in solution' };

        // Inject into page: set the input value + invoke the success callback
        const injected = await page.evaluate((token) => {
          const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
          if (input) {
            input.value = token;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          // Invoke any registered success callbacks (Turnstile API)
          const cb = (window as any).turnstileSuccessCallback;
          if (typeof cb === 'function') {
            try { cb(token); return 'callback-invoked'; } catch { return 'callback-failed'; }
          }
          return input ? 'input-set' : 'no-input';
        }, token);

        logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] CapSolver token injected (${injected}, len=${token.length})`);
        return { status: 'passed', token };
      }
    }
    return { status: 'failed', reason: 'CapSolver timeout' };
  } catch (err: any) {
    return { status: 'failed', reason: `CapSolver error: ${err.message?.slice(0, 200)}` };
  }
}

/**
 * Tier 3: OPERATOR ESCALATION. Pause the flow, save state, notify operator.
 * Returns 'paused-for-operator'. Caller is responsible for waiting on a
 * resume signal (operator pastes new cookies + signals continue).
 */
export async function escalateToOperator(page: Page, contextLabel: string): Promise<TurnstileResult> {
  const ts = Date.now();
  const recordingsDir = path.join(process.cwd(), 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const screenshotPath = path.join(recordingsDir, `turnstile_block_${contextLabel}_${ts}.png`);

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {}

  const url = page.url();
  const message = `🚨 Turnstile blocked at ${contextLabel}\nURL: ${url}\nScreenshot: ${path.basename(screenshotPath)}`;

  logEvent('warn', EventType.IP_BLOCKED, `[Turnstile] OPERATOR ESCALATION: ${message}`);
  emitToAll('TURNSTILE_OPERATOR_NEEDED', {
    context: contextLabel,
    url,
    screenshot: path.basename(screenshotPath),
    timestamp: ts,
  });

  return { status: 'paused-for-operator', reason: 'awaiting operator resolution', screenshotPath };
}

/**
 * Top-level: run the three-tier strategy. Returns final result.
 */
export async function handleTurnstile(
  page: Page,
  opts: { contextLabel: string; websiteURL?: string; skipAutoPass?: boolean; skipCapSolver?: boolean } = { contextLabel: 'unknown' },
): Promise<TurnstileResult> {
  const websiteURL = opts.websiteURL ?? page.url();
  logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] Detected at ${opts.contextLabel} (${websiteURL})`);

  // Tier 1
  if (!opts.skipAutoPass) {
    const r = await tryAutoPass(page, 30_000);
    if (r.status === 'passed') return r;
    logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] Tier 1 (auto) failed: ${r.reason}`);
  }

  // Tier 2
  if (!opts.skipCapSolver && CAPSOLVER_KEY) {
    const r = await tryCapsolver(page, websiteURL);
    if (r.status === 'passed') {
      // After injection, sometimes the form is auto-submitted; otherwise caller
      // must trigger submit. We give Cloudflare 3s to validate the token.
      await page.waitForTimeout(3000);
      // Check whether the WAF accepted by re-detecting Turnstile
      const stillBlocked = await detectTurnstile(page);
      if (!stillBlocked) return r;
      logEvent('warn', EventType.IP_BLOCKED, `[Turnstile] Tier 2 token rejected by VFS WAF`);
    } else {
      logEvent('info', EventType.MONITOR_STARTED, `[Turnstile] Tier 2 (CapSolver) failed: ${r.reason}`);
    }
  }

  // Tier 3
  return escalateToOperator(page, opts.contextLabel);
}
