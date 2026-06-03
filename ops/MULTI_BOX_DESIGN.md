# MULTI_BOX_DESIGN.md — Honest Design Note for True Multi-Box Coordination

Status: decision doc for next session. Nothing here is implemented yet.

---

## What is solved now

**Per-box DB lock (shipped).** `WORKER_LOCK_KEY` is now namespaced by `BOX_ID`:

```
worker_lock_box1   (box 1's lock row in Settings)
worker_lock_box2   (box 2's lock row in Settings)
```

Each box acquires, heartbeats, and enforces its own lock independently. No box
refuses another. Default (no `BOX_ID`) = `worker_lock` — unchanged single-box
behavior, existing deploys unaffected.

---

## The open problem — double-driving the same account

The lock fix is necessary but not sufficient for true multi-box operation.

The worker's main loop reads `Settings.scenario_run` (a shared DB flag) and then
calls `driveRun`, which picks ACTIVE accounts from the shared pool and logs into them.
With two boxes running against the same DB:

- Both boxes see `scenario_run = running`.
- Both call `driveRun`.
- Both pick the same ACTIVE account (or the same small pool).
- Both attempt a VFS login for that account simultaneously or within seconds.
- VFS sees two rapid logins from two different IPs on the same User-ID → `429001`
  (account-level ban, persists until cooldown).

**An account cannot safely be driven from more than one box at a time.**
The lock does not prevent this — it only prevents two workers on the SAME box.

---

## Budget constraint to keep in mind when sizing

Each VFS IP gets roughly **10 slot-poll calls per 2-hour sliding window** before
hitting `429201` (IP/session rate limit). The window resets on every hit, including
connectivity checks.

- 1 box, 1 account, `MONITOR_INTERVAL=120s` → ~60 calls/2h — already over budget.
  Use 240–360s (20–30 calls/2h) for safe single-account operation.
- N boxes running disjoint account sets → N × (calls per box) total; each box still
  subject to its own per-IP budget.
- Stagger accounts across boxes to avoid synchronized bursts.

---

## Two models to pick from next session

### Model 1 — Work partition (recommended starting point)

Each box is pinned to a disjoint subset of accounts/clients. No account is ever
driven by more than one box.

Implementation options:
- **`TARGET_EMAIL`** env var: the worker on box N only picks accounts whose email
  matches (or is in a comma-separated list). Simple but manual to maintain.
- **`BOX_INDEX` / `BOX_COUNT` modulo**: the worker sorts accounts by ID and takes
  `accounts where (index % BOX_COUNT) == BOX_INDEX`. Auto-partitions as the pool grows;
  requires agreeing on `BOX_COUNT` ahead of time.

Trade-off: if box 1 goes down, its accounts are unmonitored until it recovers or you
manually reassign them. No automatic rebalancing.

### Model 2 — Monitor fan-out + single booker

N boxes each log in with their **own spare detection account** purely to poll slot
availability faster and/or staggered across time. No detection account is also a
booking account.

When any box detects a slot:
1. It writes a shared signal to the DB (e.g. a `SlotDetected` event or a `Settings`
   flag with `slotCode + timestamp`).
2. A single designated **booker box** (e.g. `BOX_ID=booker`) watches for that flag
   and drives the real client booking account.

Benefits: more frequent detection without hammering any single account; detection
and booking accounts are separate so a detection 429 does not burn a client account.

Costs and open questions:
- **Detection account ≠ booking account**: the booker's account must already be logged in
  and monitoring on its own. A slot signal from box N does not give box B an open session
  — it still needs to navigate the booking wizard in its own browser context.
- The shared-signal path needs a polling loop or WebSocket on the booker side — not
  currently built.
- Detection accounts are still subject to the per-IP call budget; you need N spare
  accounts (one per detection box) plus the real client accounts.

---

## Hard constraints to flag before implementing either model

1. **Per-IP call budget is the primary throttle**, not per-box count. Adding boxes
   multiplies detection coverage only if each box has its own clean IP.
2. **Account-level 429001 is persistent** — a flagged account stays quarantined until
   the cooldown clears. Never share an account across boxes.
3. **`scenario_run` is a single global flag today.** Multi-box coordination may need
   per-box or per-account run state in the DB to avoid both boxes acting on the same
   "start" signal. This is a schema/logic change, not just a config change.
4. **Zombie workers remain a risk.** If the auto-start task fires twice (e.g. two rapid
   RDP logons), two workers launch on the same box. The per-box lock catches this, but
   monitor for zombie node processes after any restart (`Get-WmiObject Win32_Process`
   where CommandLine matches `orchestrator-worker`).

---

## Recommendation for next session

Start with **Model 1 (work partition)** using `TARGET_EMAIL` (simplest, no schema
change). Wire two boxes to disjoint accounts, confirm no double-drive 429001s, then
revisit Model 2 if faster detection cadence is needed.
