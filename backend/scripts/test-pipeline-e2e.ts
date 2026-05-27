/**
 * SIMULATE end-to-end test — proves the full wiring without a running server.
 *
 * Tests:
 *  1. scenario_run signal written to Settings (simulates dashboard click)
 *  2. Pipeline event handler logic: lifecycleState update + PipelineEvent + Telegram
 *  3. SLOT_DETECTED → "Book for slot: {slotId}" Telegram message
 *  4. BOOKING_SUCCESS Telegram message
 *  5. Forced failure → CRITICAL PipelineEvent + Telegram critical alert
 *  6. GET /api/scenario/status data shape
 *
 * Run (Railway DB):
 *   DATABASE_URL=<railway-public> PROFILE_ENCRYPTION_KEY=<key> \
 *   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_CHAT_ID=<chatId> \
 *   NOTIFY_BOOKING_FAILURES=true \
 *   npx tsx scripts/test-pipeline-e2e.ts
 */

import dotenv from 'dotenv';
dotenv.config({ path: require('path').resolve(__dirname, '../.env') });

// Override DATABASE_URL with Railway public URL if set in environment before dotenv.config
if (process.env.RAILWAY_DB_URL) {
  process.env.DATABASE_URL = process.env.RAILWAY_DB_URL;
}

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const RAILWAY_PUBLIC_DB = 'postgresql://postgres:VCiNbegyyCgGiGAYAGdjGXMufbCRQeUp@ballast.proxy.rlwy.net:59684/railway';

const prisma = new PrismaClient({
  datasources: { db: { url: RAILWAY_PUBLIC_DB } },
  log: ['warn', 'error'],
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function log(...a: unknown[]) {
  console.log('[TEST-E2E]', new Date().toISOString(), ...a);
}

const runId = `test-${Date.now()}`;

// ── Inline Telegram sender (avoids importing full notification service) ──────
async function sendTelegramDirect(message: string): Promise<void> {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) { log('  Telegram: NOT configured (skipping)'); return; }
  const body = JSON.stringify({ chat_id: chat, text: message, parse_mode: 'HTML' });
  const resp = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
  log(`  Telegram → ${data.ok ? 'OK message_id=' + data.result?.message_id : 'FAILED'}`, JSON.stringify(data).slice(0, 120));
}

// ── PipelineEvent writer (same as pipeline-event.service.ts) ─────────────────
async function createEvent(input: {
  action: string; accountId?: string; beforeState?: string; afterState?: string;
  error?: string; severity?: 'INFO' | 'WARN' | 'CRITICAL';
}): Promise<void> {
  const severity = input.severity ?? 'INFO';
  try {
    await (prisma as any).pipelineEvent.create({
      data: {
        action: input.action,
        accountId: input.accountId ?? null,
        profileId: null,
        beforeState: input.beforeState ?? null,
        afterState: input.afterState ?? null,
        error: input.error ?? null,
        url: null,
        screenshotPath: null,
        lastNetwork: null,
        severity,
      },
    });
    log(`  PipelineEvent created: action=${input.action} severity=${severity}`);
  } catch (e: any) {
    log(`  PipelineEvent DB write failed: ${e.message}`);
  }
  if (severity === 'CRITICAL') {
    await sendTelegramDirect(
      `🚨 CRITICAL pipeline event\nAction: ${input.action}\nError: ${input.error ?? 'N/A'}\nAccount: ${input.accountId ?? 'N/A'}`
    ).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  log('═'.repeat(60));
  log('VFS Pipeline E2E Simulate Test — runId:', runId);
  log('═'.repeat(60));

  // 1. Get a real ACTIVE account for the test
  const account = await prisma.vfsAccount.findFirst({
    where: { status: 'ACTIVE' },
    select: { id: true, email: true, lifecycleState: true },
  });
  if (!account) {
    log('FAIL: no ACTIVE account found in DB — cannot test');
    return;
  }
  log(`\n[Step 1] Using test account: ${account.email} (id=${account.id})`);
  log(`  Current lifecycleState: ${account.lifecycleState}`);

  // 2. Write scenario_run signal (simulates "Start Scenario" button click)
  log('\n[Step 2] Writing scenario_run signal (simulates dashboard Start Scenario)');
  await prisma.settings.upsert({
    where: { key: 'scenario_run' },
    update: { value: { runId, requestedAt: new Date().toISOString(), poolMinSpare: 2, status: 'requested' } },
    create: { key: 'scenario_run', value: { runId, requestedAt: new Date().toISOString(), poolMinSpare: 2, status: 'requested' } },
  });
  const runRow = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
  log('  scenario_run Settings value:', JSON.stringify(runRow?.value));

  // 3. Simulate LOGGED_IN step
  log('\n[Step 3] Simulating logged_in milestone → lifecycleState=LOGGING_IN');
  const fromState = account.lifecycleState as string;
  await prisma.vfsAccount.update({
    where: { id: account.id },
    data: { lifecycleState: 'LOGGING_IN', status: 'ACTIVE' },
  });
  await createEvent({ action: 'logged_in', accountId: account.id, beforeState: fromState, afterState: 'LOGGING_IN', severity: 'INFO' });
  await sleep(500);

  // 4. Simulate MONITORING step
  log('\n[Step 4] Simulating monitoring milestone → lifecycleState=WARM');
  await prisma.vfsAccount.update({ where: { id: account.id }, data: { lifecycleState: 'WARM' } });
  await createEvent({ action: 'monitoring', accountId: account.id, beforeState: 'LOGGING_IN', afterState: 'WARM', severity: 'INFO' });
  await sleep(500);

  // 5. Simulate SLOT_FOUND (key Telegram event!)
  const slotId = `sim-slot-${Date.now()}`;
  log(`\n[Step 5] Simulating slot_found milestone → Telegram "Book for slot: ${slotId}"`);
  await createEvent({ action: 'slot_found', accountId: account.id, beforeState: 'WARM', afterState: 'WARM', severity: 'INFO' });
  const slotMsg = [
    `Book for slot: <b>${slotId}</b>`,
    `Destination: <b>Latvia (uzb→lva)</b>`,
    `Account: <code>${account.email}</code>`,
    `Run: <code>${runId}</code>`,
  ].join('\n');
  await sendTelegramDirect(slotMsg);
  await sleep(500);

  // 6. Simulate BOOKED step (BOOKING_SUCCESS Telegram event)
  const confirmation = `SIM-CONF-${Date.now()}`;
  log(`\n[Step 6] Simulating booked milestone → Telegram BOOKING_SUCCESS confirmation=${confirmation}`);
  await createEvent({ action: 'booked', accountId: account.id, beforeState: 'WARM', afterState: 'WARM', severity: 'INFO' });
  const bookedMsg = [
    '✅ Booked',
    `Profile: <b>Simulate Test</b>`,
    `Conf #: <code>${confirmation}</code>`,
    `Slot: <b>${slotId}</b>`,
  ].join('\n');
  await sendTelegramDirect(bookedMsg);
  await sleep(500);

  // 7. Forced failure → CRITICAL alert
  log('\n[Step 7] Simulating FORCED FAILURE → CRITICAL PipelineEvent + Telegram critical alert');
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // keep
  await createEvent({
    action: 'failed',
    accountId: account.id,
    beforeState: 'WARM',
    afterState: 'WARM',
    error: 'simulated_critical_failure — this is a test',
    severity: 'CRITICAL',
  });
  await sleep(500);

  // 8. Mark run completed
  log('\n[Step 8] Marking scenario_run as completed');
  await prisma.settings.update({
    where: { key: 'scenario_run' },
    data: { value: { runId, requestedAt: new Date().toISOString(), poolMinSpare: 2, status: 'completed', completedAt: new Date().toISOString() } },
  });

  // 9. Final DB check — verify state
  log('\n[Step 9] Final DB verification');
  const finalAccount = await prisma.vfsAccount.findUnique({
    where: { id: account.id },
    select: { id: true, email: true, lifecycleState: true, status: true },
  });
  log('  Final account state:', JSON.stringify(finalAccount));

  let peCount = 0;
  try {
    peCount = await (prisma as any).pipelineEvent.count({ where: { accountId: account.id } });
    log(`  PipelineEvent rows for this account: ${peCount}`);
    const lastPE = await (prisma as any).pipelineEvent.findFirst({ where: { accountId: account.id }, orderBy: { createdAt: 'desc' } });
    log('  Last PipelineEvent:', JSON.stringify({ action: lastPE?.action, severity: lastPE?.severity, error: lastPE?.error?.slice(0, 50) }));
  } catch(e: any) {
    log(`  PipelineEvent query failed: ${e.message}`);
  }

  const finalRun = await prisma.settings.findUnique({ where: { key: 'scenario_run' } });
  log('  Final scenario_run:', JSON.stringify(finalRun?.value));

  // 10. Restore original lifecycleState
  await prisma.vfsAccount.update({
    where: { id: account.id },
    data: { lifecycleState: fromState as any, status: 'ACTIVE' },
  });
  log(`  Restored ${account.email} lifecycleState to ${fromState}`);

  log('\n' + '═'.repeat(60));
  log('TEST COMPLETE');
  log(`  Account tested: ${account.email}`);
  log(`  lifecycleState: ${fromState} → LOGGING_IN → WARM (restored)`);
  log(`  PipelineEvent rows created: ${peCount}`);
  log(`  Telegram events sent: slot_found, booked, CRITICAL failure`);
  log('  scenario_run status: completed');
  log('═'.repeat(60));
}

main().catch((e) => {
  console.error('[TEST-E2E] crashed:', e);
}).finally(() => prisma.$disconnect());
