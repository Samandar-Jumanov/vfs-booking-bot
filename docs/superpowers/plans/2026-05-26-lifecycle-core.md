# Lifecycle Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, VFS-free core of the account lifecycle — the state machine and the pacer — that decides what an account may do next and when, so no automated process can ever re-hit a restricted account or hammer VFS.

**Architecture:** Two pure modules with no I/O. `state-machine.ts` is a pure function `nextState(current, event) → transition`. `pacer.ts` decides, given timing data + now, whether an account is *due* for an action and whether the global limiter permits it. Both are fully unit-tested with no DB, no network, no VFS. Later plans wire these to Prisma + a `BrowserDriver`.

**Tech Stack:** TypeScript (strict), Jest (existing in `backend/`), no new deps.

---

## File Structure

- Create `backend/src/modules/lifecycle/types.ts` — `LifecycleState`, `LifecycleEvent`, `DriverResult`, `PacerConfig`, `AccountTiming`.
- Create `backend/src/modules/lifecycle/state-machine.ts` — pure `nextState()`.
- Create `backend/src/modules/lifecycle/pacer.ts` — pure `isDue()` / `pickNextDue()` / `permitsGlobalAction()`.
- Create `backend/src/modules/lifecycle/__tests__/state-machine.test.ts`.
- Create `backend/src/modules/lifecycle/__tests__/pacer.test.ts`.

Each file has one responsibility; no file imports Prisma, the WS server, or any VFS code.

---

### Task 1: Types

**Files:**
- Create: `backend/src/modules/lifecycle/types.ts`

- [ ] **Step 1: Write the types**

```ts
// backend/src/modules/lifecycle/types.ts

/** The single authoritative lifecycle state of a VFS account. */
export type LifecycleState =
  | 'NEW'
  | 'REGISTERING'
  | 'REGISTER_FAILED'
  | 'PENDING_ACTIVATION'
  | 'ACTIVATING'
  | 'ACTIVE'
  | 'LOGGING_IN'
  | 'WARM'
  | 'RESTRICTED'
  | 'BLOCKED';

/** Outcome codes a BrowserDriver/activator/poller can report. */
export type ResultCode =
  | 'OK'
  | '429001'        // account-scoped Access Restricted (persistent)
  | '429202'        // IP/session throttle (~2h)
  | 'TURNSTILE_FAILED'
  | 'INVALID_CREDS'
  | 'NO_WARM_TAB'
  | 'OPERATOR_OFFLINE'
  | 'NO_EMAIL_LINK'  // Mailsac activation link not found yet
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface DriverResult {
  ok: boolean;
  code: ResultCode;
  reason?: string;
  data?: Record<string, unknown>;
}

/** Events that drive a transition. A step result, or a timed trigger. */
export type LifecycleEvent =
  | { kind: 'STEP_RESULT'; step: 'register' | 'activate' | 'login'; result: DriverResult }
  | { kind: 'COOLDOWN_ELAPSED' }
  | { kind: 'SESSION_STALE' };       // WARM session aged past freshness threshold

export interface PacerConfig {
  /** Min ms between any two VFS-touching actions globally. */
  globalMinGapMs: number;
  /** Min ms before the same account may be driven again. */
  perAccountMinIntervalMs: number;
  /** Cooldown applied on 429202 (IP/session). */
  cooldown429202Ms: number;
  /** Cooldown applied on 429001 (account). */
  cooldown429001Ms: number;
  /** +/- fraction of jitter applied to gaps (0.3 = ±30%). */
  jitterFraction: number;
}

export interface AccountTiming {
  id: string;
  lifecycleState: LifecycleState;
  /** ms epoch of last action against this account, or null. */
  lastAttemptAt: number | null;
  /** ms epoch until which the account is in cooldown, or null. */
  cooldownUntil: number | null;
  /** ms epoch the WARM session was established, or null. */
  warmedAt: number | null;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/modules/lifecycle/types.ts
git commit -m "feat(lifecycle): core types (states, events, driver result, pacer config)"
```

---

### Task 2: State machine — register path

**Files:**
- Create: `backend/src/modules/lifecycle/state-machine.ts`
- Test: `backend/src/modules/lifecycle/__tests__/state-machine.test.ts`

- [ ] **Step 1: Write failing tests for the register transitions**

```ts
// backend/src/modules/lifecycle/__tests__/state-machine.test.ts
import { nextState } from '../state-machine';
import type { DriverResult } from '../types';

const ok = (data?: Record<string, unknown>): DriverResult => ({ ok: true, code: 'OK', data });
const fail = (code: any): DriverResult => ({ ok: false, code });

describe('nextState — register path', () => {
  it('NEW + register OK → PENDING_ACTIVATION, attempt reset', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: ok() }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('PENDING_ACTIVATION');
    expect(t.resetAttempts).toBe(true);
  });

  it('NEW + register fail (retries left) → REGISTER_FAILED, no cooldown', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: fail('TIMEOUT') }, { attemptCount: 1, maxAttempts: 3 });
    expect(t.state).toBe('REGISTER_FAILED');
    expect(t.cooldownMs).toBeUndefined();
  });

  it('NEW + register fail (retries exhausted) → BLOCKED', () => {
    const t = nextState('NEW', { kind: 'STEP_RESULT', step: 'register', result: fail('TIMEOUT') }, { attemptCount: 3, maxAttempts: 3 });
    expect(t.state).toBe('BLOCKED');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/state-machine.test.ts`
Expected: FAIL — "Cannot find module '../state-machine'".

- [ ] **Step 3: Implement the register path**

```ts
// backend/src/modules/lifecycle/state-machine.ts
import type { LifecycleState, LifecycleEvent } from './types';

export interface TransitionCtx { attemptCount: number; maxAttempts: number; }
export interface Transition {
  state: LifecycleState;
  cooldownMs?: number;       // set cooldownUntil = now + cooldownMs
  resetAttempts?: boolean;   // reset attemptCount to 0
  bumpAttempts?: boolean;    // attemptCount += 1
  rotate?: boolean;          // flag account for rotation (429001)
}

export function nextState(current: LifecycleState, event: LifecycleEvent, ctx: TransitionCtx): Transition {
  if (event.kind === 'STEP_RESULT' && event.step === 'register') {
    const r = event.result;
    if (r.ok) return { state: 'PENDING_ACTIVATION', resetAttempts: true };
    if (ctx.attemptCount >= ctx.maxAttempts) return { state: 'BLOCKED' };
    return { state: 'REGISTER_FAILED', bumpAttempts: true };
  }
  return { state: current }; // no-op for unhandled (filled in next tasks)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/state-machine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/lifecycle/state-machine.ts backend/src/modules/lifecycle/__tests__/state-machine.test.ts
git commit -m "feat(lifecycle): state machine register transitions"
```

---

### Task 3: State machine — activate + login + 429 + cooldown paths

**Files:**
- Modify: `backend/src/modules/lifecycle/state-machine.ts`
- Modify: `backend/src/modules/lifecycle/__tests__/state-machine.test.ts`

- [ ] **Step 1: Add failing tests for the remaining transitions**

```ts
// append to state-machine.test.ts
describe('nextState — activate/login/429/cooldown', () => {
  it('PENDING_ACTIVATION + activate OK → ACTIVE', () => {
    expect(nextState('PENDING_ACTIVATION', { kind: 'STEP_RESULT', step: 'activate', result: ok() }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
  it('PENDING_ACTIVATION + activate NO_EMAIL_LINK → stays PENDING_ACTIVATION (retry later)', () => {
    expect(nextState('PENDING_ACTIVATION', { kind: 'STEP_RESULT', step: 'activate', result: fail('NO_EMAIL_LINK') }, { attemptCount: 1, maxAttempts: 5 }).state).toBe('PENDING_ACTIVATION');
  });
  it('ACTIVE + login OK → WARM', () => {
    expect(nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: ok() }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('WARM');
  });
  it('login 429001 → RESTRICTED, long cooldown, rotate flagged', () => {
    const t = nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: fail('429001') }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('RESTRICTED');
    expect(t.rotate).toBe(true);
    expect(t.cooldownMs).toBeGreaterThan(0);
  });
  it('login 429202 → RESTRICTED, short cooldown, no rotate', () => {
    const t = nextState('ACTIVE', { kind: 'STEP_RESULT', step: 'login', result: fail('429202') }, { attemptCount: 0, maxAttempts: 3 });
    expect(t.state).toBe('RESTRICTED');
    expect(t.rotate).toBeFalsy();
  });
  it('RESTRICTED + COOLDOWN_ELAPSED → ACTIVE (resume)', () => {
    expect(nextState('RESTRICTED', { kind: 'COOLDOWN_ELAPSED' }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
  it('WARM + SESSION_STALE → ACTIVE (needs re-login)', () => {
    expect(nextState('WARM', { kind: 'SESSION_STALE' }, { attemptCount: 0, maxAttempts: 3 }).state).toBe('ACTIVE');
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/state-machine.test.ts`
Expected: FAIL on the new cases (they hit the no-op branch).

- [ ] **Step 3: Extend `nextState`**

Replace the body of `nextState` so it handles all events. The two cooldown constants are passed via a small module-level default; tests assert `>0`, so concrete values live here:

```ts
const COOLDOWN_429001_MS = 6 * 60 * 60 * 1000; // 6h account restriction
const COOLDOWN_429202_MS = 2 * 60 * 60 * 1000; // 2h IP/session

export function nextState(current: LifecycleState, event: LifecycleEvent, ctx: TransitionCtx): Transition {
  if (event.kind === 'COOLDOWN_ELAPSED') {
    return { state: 'ACTIVE' }; // resume point after a restriction clears
  }
  if (event.kind === 'SESSION_STALE') {
    return current === 'WARM' ? { state: 'ACTIVE' } : { state: current };
  }
  // STEP_RESULT
  const r = event.result;
  // 429s short-circuit any step → RESTRICTED.
  if (r.code === '429001') return { state: 'RESTRICTED', cooldownMs: COOLDOWN_429001_MS, rotate: true };
  if (r.code === '429202') return { state: 'RESTRICTED', cooldownMs: COOLDOWN_429202_MS };

  if (event.step === 'register') {
    if (r.ok) return { state: 'PENDING_ACTIVATION', resetAttempts: true };
    if (ctx.attemptCount >= ctx.maxAttempts) return { state: 'BLOCKED' };
    return { state: 'REGISTER_FAILED', bumpAttempts: true };
  }
  if (event.step === 'activate') {
    if (r.ok) return { state: 'ACTIVE', resetAttempts: true };
    if (r.code === 'NO_EMAIL_LINK' && ctx.attemptCount < ctx.maxAttempts) {
      return { state: 'PENDING_ACTIVATION', bumpAttempts: true }; // keep polling
    }
    return ctx.attemptCount >= ctx.maxAttempts ? { state: 'BLOCKED' } : { state: 'PENDING_ACTIVATION', bumpAttempts: true };
  }
  if (event.step === 'login') {
    if (r.ok) return { state: 'WARM', resetAttempts: true };
    return ctx.attemptCount >= ctx.maxAttempts ? { state: 'BLOCKED' } : { state: 'ACTIVE', bumpAttempts: true };
  }
  return { state: current };
}
```

- [ ] **Step 4: Run all state-machine tests**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/state-machine.test.ts`
Expected: PASS (all tests, register + new).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/lifecycle/state-machine.ts backend/src/modules/lifecycle/__tests__/state-machine.test.ts
git commit -m "feat(lifecycle): activate/login/429/cooldown/stale transitions"
```

---

### Task 4: Pacer — global gap + per-account interval + cooldown

**Files:**
- Create: `backend/src/modules/lifecycle/pacer.ts`
- Test: `backend/src/modules/lifecycle/__tests__/pacer.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// backend/src/modules/lifecycle/__tests__/pacer.test.ts
import { isDue, pickNextDue, permitsGlobalAction } from '../pacer';
import type { PacerConfig, AccountTiming } from '../types';

const cfg: PacerConfig = {
  globalMinGapMs: 60_000, perAccountMinIntervalMs: 90_000,
  cooldown429202Ms: 7_200_000, cooldown429001Ms: 21_600_000, jitterFraction: 0,
};
const acct = (over: Partial<AccountTiming>): AccountTiming => ({
  id: 'a', lifecycleState: 'ACTIVE', lastAttemptAt: null, cooldownUntil: null, warmedAt: null, ...over,
});

describe('pacer', () => {
  const now = 1_000_000_000_000;

  it('account in cooldown is NOT due', () => {
    expect(isDue(acct({ cooldownUntil: now + 1000 }), cfg, now)).toBe(false);
  });
  it('account past cooldown + never attempted is due', () => {
    expect(isDue(acct({ cooldownUntil: now - 1, lastAttemptAt: null }), cfg, now)).toBe(true);
  });
  it('account attempted within per-account interval is NOT due', () => {
    expect(isDue(acct({ lastAttemptAt: now - 10_000 }), cfg, now)).toBe(false);
  });
  it('BLOCKED account is never due', () => {
    expect(isDue(acct({ lifecycleState: 'BLOCKED', lastAttemptAt: null }), cfg, now)).toBe(false);
  });
  it('global limiter blocks if last global action too recent', () => {
    expect(permitsGlobalAction(now - 10_000, cfg, now)).toBe(false);
    expect(permitsGlobalAction(now - 120_000, cfg, now)).toBe(true);
    expect(permitsGlobalAction(null, cfg, now)).toBe(true);
  });
  it('pickNextDue returns the least-recently-attempted due account', () => {
    const list = [acct({ id: 'x', lastAttemptAt: now - 200_000 }), acct({ id: 'y', lastAttemptAt: null })];
    expect(pickNextDue(list, cfg, now)?.id).toBe('y'); // never-attempted sorts first
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/pacer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pacer**

```ts
// backend/src/modules/lifecycle/pacer.ts
import type { PacerConfig, AccountTiming, LifecycleState } from './types';

const TERMINAL: LifecycleState[] = ['BLOCKED'];

export function isDue(a: AccountTiming, cfg: PacerConfig, now: number): boolean {
  if (TERMINAL.includes(a.lifecycleState)) return false;
  if (a.cooldownUntil != null && a.cooldownUntil > now) return false;
  if (a.lastAttemptAt != null && now - a.lastAttemptAt < cfg.perAccountMinIntervalMs) return false;
  return true;
}

export function permitsGlobalAction(lastGlobalActionAt: number | null, cfg: PacerConfig, now: number): boolean {
  if (lastGlobalActionAt == null) return true;
  return now - lastGlobalActionAt >= cfg.globalMinGapMs;
}

/** Least-recently-attempted due account (never-attempted first). */
export function pickNextDue(accounts: AccountTiming[], cfg: PacerConfig, now: number): AccountTiming | null {
  const due = accounts.filter((a) => isDue(a, cfg, now));
  if (due.length === 0) return null;
  due.sort((x, y) => (x.lastAttemptAt ?? -1) - (y.lastAttemptAt ?? -1));
  return due[0];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest src/modules/lifecycle/__tests__/pacer.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/lifecycle/pacer.ts backend/src/modules/lifecycle/__tests__/pacer.test.ts
git commit -m "feat(lifecycle): pacer (global gap, per-account interval, cooldown, pickNextDue)"
```

---

### Task 5: Full type-check + suite green

- [ ] **Step 1: Type-check the whole backend**

Run: `cd backend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Run the lifecycle tests together**

Run: `cd backend && npx jest src/modules/lifecycle`
Expected: PASS (all state-machine + pacer tests).

- [ ] **Step 3: Commit (if any fixups were needed)**

```bash
git add -A backend/src/modules/lifecycle
git commit -m "chore(lifecycle): core type-check + suite green" || echo "nothing to commit"
```

---

## Self-Review

- **Spec coverage:** Covers the spec's state machine (§3) and pacing (§4) — every state + the 429001/429202 distinction + cooldown/stale transitions + the "RESTRICTED never driven / never-batch pickNextDue" rules. Persistence, LifecycleService, drivers, Mailsac, 2Captcha, booking, keepalive are explicitly deferred to Plans 2–4.
- **Placeholder scan:** No TBD/TODO; every code step has full code; every test has real assertions.
- **Type consistency:** `nextState(current, event, ctx) → Transition`; `Transition` fields (`state`, `cooldownMs`, `resetAttempts`, `bumpAttempts`, `rotate`) used consistently. Pacer uses `AccountTiming`/`PacerConfig` exactly as defined in Task 1. `ResultCode` values (`429001`, `429202`, `NO_EMAIL_LINK`, …) match between types and the state machine.
