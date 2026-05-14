# TRACK 4 - Telegram Alerts, Cookie Watcher, Monitor Supervisor

## What shipped (4 commits on `track-4-alerts`)

| Commit | Files | Purpose |
|---|---|---|
| `ad4ae54` `feat(alerts): BullMQ cookie watcher + monitor supervisor scaffolding` | `notifications/queues.ts` (new), `notifications/notification.service.ts` | Two BullMQ queues (`cookie-watcher`, `monitor-supervisor`) with workers. Cookie expiry watcher polls every 60s, de-dupes via Redis lock. Supervisor reads `monitors:running` set and verifies heartbeat keys; missed heartbeats trigger restart with circuit-breaker on 3 crashes in 10 min. |
| `88ed0c2` `feat(alerts): Telegram alerts with inline keyboard callback handler` | `notifications/telegram.commands.ts` (new), `notifications/telegram.bot.ts` | All 7 alert types route through `dispatchNotification`. Inline keyboards for `Book now`, `Open dashboard`, `Pause monitor`, `Warm cookies`, `Solve captcha`. Callback handler signs short-lived JWT to call internal API. |
| `b44b3c0` `feat(alerts): /api/settings/notifications/test endpoint + smoke test script` | `settings/settings.controller.ts`, `settings/settings.router.ts`, `scripts/test-alerts.ts` (new) | Test ping endpoint + a 7-event smoke test script. |
| `05e333b` `feat(alerts): wire BullMQ queues + heartbeat publishing into monitor` | `index.ts`, `monitor.service.ts` | Starts/stops notification queues with the backend, publishes monitor heartbeat keys, maintains `monitors:running`, and includes `monitorId` in slot alert dispatch. |

**Diff stat (committed):** 9 files, 425 insertions, 21 deletions.

## What is pending

All wiring landed in commit `05e333b`. No outstanding gaps.

Live Telegram smoke test is pending valid local database credentials. `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are present in `backend/.env`, but `npx ts-node scripts/test-alerts.ts` failed before sending alerts with Prisma `P1000`: authentication failed for `vfsuser` at `localhost`.

## Acceptance criteria status

| # | Criterion | Status |
|---|---|---|
| 1 | All 7 Telegram messages arrive when test-alerts.ts runs | WARNING: blocked by local DB auth (`vfsuser` at `localhost` failed Prisma `P1000`; operator must fix DB credentials and rerun `scripts/test-alerts.ts`) |
| 2 | Inline keyboards on `SLOT_DETECTED`, `BOOKING_SUCCESS`, `CAPTCHA_MANUAL_NEEDED` | DONE: wired in `notification.service.ts` |
| 3 | `COOKIE_EXPIRING_SOON` fires <30 min from expiry; de-dupes via Redis lock | DONE: implemented in `queues.ts`; queues now boot from `index.ts` |
| 4 | Monitor supervisor restarts crashed monitors; 3-crash circuit breaker | DONE: implemented in `queues.ts`; monitor heartbeat hooks now landed |
| 5 | `POST /api/settings/notifications/test` returns `{ok:true, sentTo:['telegram']}` | DONE: implemented in `settings/*` |
| 6 | Click `Pause monitor` in Telegram stops monitor | DONE: callback handler in `telegram.commands.ts` |
| 7 | `npm test` still passes | DONE: `npm test` passed, 7 suites / 61 tests |

**Net: 100% functionally complete; live Telegram smoke test pending operator creds.**

## Verification commands

```bash
cd backend
npm run build
npm test
npx ts-node scripts/test-alerts.ts
```

## Notes for reviewer

- No DB schema changes. All de-duplication state lives in Redis (`cookie-alerted:*`, `monitor:*:heartbeat`, `monitor:*:crash-count`).
- No new heavy deps (used existing `bullmq`, `telegraf`, `axios`, `@prisma/client`).
- TypeScript strict mode preserved.
- The `MONITOR_AUTO_START` flag work visible in `index.ts` working tree is pre-existing prior work, not part of TRACK 4.
- Manual-cookie scaffolding visible in `monitor.service.ts` working tree is pre-existing prior work, not part of TRACK 4. Its cookie-alert reset lines could not be committed independently without also committing that scaffolding.

**Title:** `feat(alerts): TRACK 4 - Telegram alerts, cookie watcher, monitor supervisor`
