# Stabilize Report (2026-05-29)

## TL;DR

- **Task 1:** 1 failing test fixed. **Verdict: test was stale** — the `selectFreshWatcherAccount` function correctly stamps `lastUsedAt` on account selection for round-robin pacing; the old assertion `not.toHaveBeenCalled()` was written before this function existed. Test updated to assert the expected `lastUsedAt` touch. `npm test` now **166/166 green**, `npm run build` still clean.
- **Task 2:** 69 zero-byte junk artifact files deleted. 1 skipped (`backend/.([profileId])n.swp`, 4096 bytes vim swap — non-zero per double-guard rule). Zero PROTECT-LIST or non-zero-byte files removed.
- **Task 3:** `CLAUDE.md` current-state section updated to 2026-05-29. Added top reader note. Replaced stale "Turnstile blocker + unvalidated Steps 2–5" with verified facts: nodriver login works, OTP IS wired, build/test status, and e2e/SIMULATE prod-DB footgun.
- No commit/push performed. Changes left staged in working tree.

---

## Task 1 — Monitor test fix

### Verdict: **TEST WAS STALE** (code is correct)

#### Root cause analysis

The test `"logs in the stored VFS account and retries once after a 403 poll response"` asserted:
```typescript
expect(prisma.vfsAccount.update).not.toHaveBeenCalled();
```

This was written before the commit `e6f9506` ("feat(accounts): add PollingRole") which refactored `getStoredVfsSession` to delegate to a new exported function `selectFreshWatcherAccount`. That function adds:

```typescript
// monitor.service.ts lines 496-499 (added in e6f9506)
await prisma.vfsAccount.update({
  where: { id: account.id },
  data: { lastUsedAt: new Date() },
}).catch(() => undefined);
```

**Why this touch is correct (tied to 429-avoidance pacing):**
`selectFreshWatcherAccount` orders candidates by `{ lastUsedAt: 'asc' }` (least-recently-used first) to implement round-robin account rotation across polling cycles. Without stamping `lastUsedAt` on selection, the same account would be re-selected on every single poll cycle (since its `lastUsedAt` never changes), which is exactly the behavior that causes VFS **429202** (IP/session rate-limit). The stamp must happen at selection time — before the poll result is known — so that even a 403 "uses up" the account's slot in the rotation and prevents immediate re-selection.

The second test ("marks the stored VFS account stale when retry also fails") already passes with the new code, because it uses `toHaveBeenCalledWith({ lastWarmedAt: null })` which matches any call containing those args — it's unaffected by the additional `lastUsedAt` call.

#### File changed

`backend/src/modules/monitor/monitor.service.test.ts` — line 205 only.

#### Diff

```diff
-    expect(prisma.vfsAccount.update).not.toHaveBeenCalled();
+    // selectFreshWatcherAccount touches lastUsedAt on selection (round-robin pacing).
+    // It should NOT also write lastWarmedAt:null (that would only happen if the retry also 403d).
+    expect(prisma.vfsAccount.update).toHaveBeenCalledTimes(1);
+    expect(prisma.vfsAccount.update).toHaveBeenCalledWith({
+      where: { id: 'acc-1' },
+      data: { lastUsedAt: expect.any(Date) },
+    });
```

The updated assertion verifies:
1. Update called **exactly once** (only `lastUsedAt`, not `lastWarmedAt: null`)
2. The call was specifically the pacing stamp — not the session-stale invalidation

#### Evidence

```
npm test  →  Tests: 166 passed, 166 total  (0 failed)
             Test Suites: 22 passed, 22 total
             Time: 4.438 s

npm run build  →
  > backend@1.0.0 build
  > tsc --project tsconfig.json && tsc-alias -p tsconfig.json
  (exit 0, no output = no errors)
```

---

## Task 2 — Junk cleanup

### Files deleted: 69

All confirmed zero bytes before deletion (via `Get-Item -LiteralPath.Length -eq 0` guard). Deleted using `Remove-Item -LiteralPath` (literal paths, no glob expansion).

**Root-level (33):**
`'')`, `((x.innerText`, `(o.textContent`, `(t.id`, `({`, `({,`, `0)`, `15-30s`, `200`, `400)`, `403,`, `Oxylabs`, `Telegram`, `c.checked).length})`, `console.log('[VFS-SW]'`, `d.file`, `i.offsetParent!`, `i.status`, `id`, `len(triggers)`, `re.test((o.textContent`, `t.id`, `undefined)`, `void)`, `{`, `{,+`, `{await`, `{console.error('ERR'`, `{console.error(e.message)`, `{console.log('ERR'`, `{console.log('accounts`, `{console.log('queue`, `{const`

**`backend/` (29):**
`({`, `({})))`, `200`, `400)`, `Oxylabs`, `[]`, `c.checked).length})`, `console.error('[scenario]`, `console.log('ERR'`, `console.log(k+'`, `k+'`, `prisma.$disconnect())`, `prisma/$disconnect())`, `slot-API`, `t.id`, `{await`, `{console.error('ERR'`, `{console.log('ERR'`, `{console.log('FAIL`, `{console.log('PENDING`, `{console.log('accounts`, `{console.log('count`, `{console.log('pipeline_events`, `{console.log('queue`, `{console.log(JSON.stringify(a))`, `{const`, `{{const`, `{})`, `[]` (dup, already gone from first pass)

**`nodriver-spike/` (6):**
`'`, `((x.innerText`, `b.offsetParent!`, `e`, `i.getAttribute('formcontrolname')`, `{const`, `{{const`

**`extension/` (1):**
`Oxylabs`

### Skipped (non-zero byte):

| File | Size | Reason |
|---|---|---|
| `backend/.([profileId])n.swp` | 4096 bytes | Vim swap file — non-zero, skipped per double-guard |

### Confirmed zero PROTECT-LIST files removed

All items from the PROTECT-LIST are present in the post-cleanup `git status`:
- All `*.md` plan/report docs ✓
- `backend/scripts/check-test-account.ts`, `find-clean-account.ts`, `reveal-cred.ts`, `set-cred.ts` ✓
- `backend/src/spike-rebrowser-login.ts` ✓
- All `deployments/*.png` + `deployments/state-and-scenarios.html` ✓
- All `docs/superpowers/plans/*.md` ✓
- `frontend/.eslintrc.json` ✓
- All `scripts/*.js` ✓
- `.claude/scheduled_tasks.lock` ✓
- `n5.png` ✓

No OneDrive lock errors encountered.

### `git status --porcelain` after cleanup

```
 M .claude/worktrees/sharp-wescoff-bb0f0f
 M backend/scripts/orchestrator-worker.ts
 M backend/scripts/verify-vfs-reachable.js
 M backend/src/modules/monitor/monitor.service.test.ts
 M launch-bot-chrome.ps1
 M nodriver-spike/auto_pipeline.py
?? .claude/scheduled_tasks.lock
?? CLAUDE_CODE_DIAGNOSTIC_PLAN.md
?? CLAUDE_CODE_STABILIZE_PLAN.md
?? CODEX_FINISH_LINE_STARTER.md
?? CODEX_PRODUCTION_READY_STARTER.md
?? CODEX_VERIFY_AND_FIX_STARTER.md
?? DIAGNOSTIC_REPORT.md
?? INFRA_SHOPPING_LIST.md
?? PASTE_TO_SONNET_PIPELINE.md
?? PHASE1_CLAUDE_PLAN.md
?? PHASE1_STAGE_A_REPORT.md
?? VPS_SETUP_CONTABO.md
?? backend/.([profileId])n.swp
?? backend/scripts/check-test-account.ts
?? backend/scripts/find-clean-account.ts
?? backend/scripts/reveal-cred.ts
?? backend/scripts/set-cred.ts
?? backend/src/spike-rebrowser-login.ts
?? deployments/a1.1.png  [+35 more deployment images/html]
?? docs/superpowers/plans/2026-05-26-plan2-persistence-lifecycle-service.md  [+2]
?? frontend/.eslintrc.json
?? n5.png
?? scripts/bootstrap-test-flow.js  [+7 more scripts]
[+ STABILIZE_REPORT.md once written]
```

(Truncated for readability — full output in Task 2 run above.)

---

## Task 3 — CLAUDE.md refresh

### Summary of changes

| What | Old | New |
|---|---|---|
| Date stamp | `updated 2026-05-25` | `updated 2026-05-29` |
| Top reader note | absent | Added 2-line `⚠️` blockquote redirecting readers to Current State |
| Architecture summary | Chrome extension + `chrome.debugger` (primary) | nodriver Python spike (primary); extension runs sniffer/monitor only |
| "Working" section | 3 bullets: register/activate, slot monitoring, Booking Step 1 only | Expanded: nodriver login, register/activate, monitoring (with correct auth headers), Booking Steps 1–5 with OTP and Submit details |
| OTP status | Not mentioned | **`mailsac_otp_code()` IS wired at `auto_pipeline.py:486`**; blocker is `MAILSAC_API_KEY` env |
| "Active blocker" | "Turnstile blocks auto-login; Steps 2–5 unvalidated" | Replaced with "Active constraint": hands-off works for fresh accounts; operator assists for flagged ones |
| Build/test status | Not present | New section: 166/166 tests, build clean, e2e/SIMULATE prod-DB footgun |
| Full chain proven | Not mentioned | create→activate→login→monitor proven live 2026-05-28; booking submit gated on real slot |

**What was kept unchanged:**
- VPN→BrightData `ip_blacklisted` gotcha
- Proxy optional on UZ residential (env flags)
- `LOGIN_CRON_ENABLED` / `NOTIFY_BOOKING_FAILURES` default OFF
- Diagnostic/trigger scripts list

### `git diff CLAUDE.md` (key sections)

See the diff captured above — changes: +2 lines top of file, +35 lines in Current State (net +14 after old content removed). No other sections touched.

---

## Anything I noticed but did NOT touch

1. **`backend/.([profileId])n.swp`** (4096 bytes) — vim swap file. Non-zero so not deleted per rules. If vim is not running against this file, it can be safely removed manually.
2. **Lint: 42 ESLint errors** remain — unused vars, empty catch blocks, one `require()` instead of import. All cosmetic, no logic impact. Not touched (out of Task 1 scope).
3. **`backend/scripts/orchestrator-worker.ts`** has an uncommitted change (single-instance lock removal) that was already in the working tree before this session. Not touched.

---

## State left for the operator

**Modified (staged in working tree, not committed):**
- `backend/src/modules/monitor/monitor.service.test.ts` — Task 1 test fix (6-line change)
- `CLAUDE.md` — Task 3 refresh (top pointer + Current State section)

**Deleted (untracked junk files removed, not committed):**
- 69 zero-byte shell-redirect artifact files (Task 2)

**Not committed, not pushed. All per plan rules.**
