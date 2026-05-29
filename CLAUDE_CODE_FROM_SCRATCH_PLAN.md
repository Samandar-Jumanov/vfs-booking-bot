# Claude Code Plan — From-Scratch Armed Run Prep

> **Executor:** Claude Code (Sonnet 4.6)
> **Goal:** Make the **zero-state** chain reliable — bot registers a BRAND-NEW Mailsac account → activates → logs in → monitors OCMA → books — so the operator can run the whole thing from nothing (sidestepping throttled existing accounts). Verify the wiring, close the one real gap (can a fresh *unlinked* account actually book?), harden registration only where a true gap exists, update the runbook, keep the suite green.
> **Type:** Verify + surgical harden. **No live VFS / login / register / booking from here** (no UZ IP). The live run is the operator's.

---

## 0. Why this plan exists (context you must understand first)

The operator wants to run from scratch because the system mints its own accounts — a fresh account has no throttle history and a Mailsac email (so OTP + activation are auto-handled). The worker's pool top-up already calls `registerOne()` → `register_spike.py`.

**The known risk this plan de-risks:** live registration is rate-limited (~5 attempts, then VFS throttles). So the fresh-register → book chain must be verified to work end-to-end on paper BEFORE the operator burns a live attempt.

**The specific open question (found by reading the code):**
- `orchestrator-worker.ts` defines a spare/fresh pool account as `status:'ACTIVE'` **AND `profileIds` empty** (line ~492).
- When the worker drives an account (line ~319–353), it only sets `PROFILE_*` env **if a profile is linked**. A freshly-registered account is unlinked → **no `PROFILE_FIRSTNAME/LASTNAME/NATIONALITY/PASSPORT/EMAIL/CONTACT`** reach `auto_pipeline.py`.
- Booking Step 2 is a **passport-image OCR upload** (`p1.png`), not a text form — so identity may come from the scan. **But** later booking steps (contact details, etc.) may still need `PROFILE_*` data.
- **So: will a brand-new unlinked account complete booking with only `p1.png`, or does it stall for missing contact/profile data?** This plan must answer that definitively and, if it would stall, close the gap minimally.

**HARD RULES:**
1. No live VFS/login/register/booking/OTP from here. Read-only prod-DB inspection scripts allowed (mask secrets); never mutate prod data.
2. Code edits allowed only where a task calls for them; keep surgical, match existing style.
3. No `git commit`/`push`/PR. Leave changes staged.
4. OneDrive path: skip on `.lock` errors. Don't create new shell-redirect junk files (avoid stray `> ...` redirects).
5. Keep `npm test` at 166/166.

---

## 1. What "done" looks like

- A definitive answer: **does a fresh, ACTIVE, unlinked account book successfully with only `p1.png`?** (Yes → no change needed. No → the minimal gap-closing fix is implemented.)
- The from-scratch trigger is documented (how the operator makes the worker register exactly one fresh account and drive it to book).
- Registration emits progress milestones to Telegram (form rendered → consents ticked → submitted → registered → activated), and any genuine fill gap is hardened.
- `npm test` 166/166, `npm run build` clean, `py_compile` clean.
- `ARMED_RUN_RUNBOOK.md` updated with a **zero-state start** section.
- `FROM_SCRATCH_PREP_REPORT.md` written. Nothing committed.

---

## 2. Tasks (in order)

### Task 1 — Trace the zero-state chain end-to-end (read-only first)
**What to do — read and document the actual flow:**
1. In `orchestrator-worker.ts`: confirm how pool top-up triggers `registerOne()` (the `spare < poolMin` path, ~line 503–517). Document **exactly what makes the worker register a fresh account** on a clean start (env: `POOL_MIN`? empty pool? a trigger script `trigger-register`?). Identify the **cleanest single way** for the operator to kick off one fresh registration + drive-to-book.
2. Confirm the fresh account's lifecycle: `registerOne()` persists it as which status? How does it get **activated** (worker reconcile via Mailsac link)? Confirm activation is automatic for a Mailsac email.
3. **The critical question:** trace `book()` in `auto_pipeline.py` Steps 2→5 and list **every applicant field it actually consumes** and where each comes from (`p1.png` OCR vs `PROFILE_*` env vs the account's own registered email/phone). Determine: **with NO linked profile (PROFILE_* all empty) but `p1.png` present, does booking have everything it needs?** Pay attention to any contact-details / email / phone step.
**Done when:** Report states (a) the exact from-scratch trigger, (b) the fresh-account activation path, (c) a field-by-field verdict on whether an unlinked fresh account is bookable with only `p1.png`. If the answer is "stalls without contact data," Task 3 fixes it.

### Task 2 — Registration progress milestones + harden only real gaps
**What to do:**
1. In `register_spike.py`, confirm/add `milestone(...)` calls so the operator sees registration progress in Telegram: at minimum `register_started`, `form_rendered` (or the existing `failed/form_not_rendered`), `consents_ticked`, `register_submitted`, and the existing `registered`. Wire any new steps through `pipeline.router.ts` so they reach Telegram (short human messages).
2. Review the consent-tick verification loop (`boxes_state`, ~line 270–292) and the **Register button click**: memory says the Register button was once **below the fold** (off-screen coord-click hit nothing) — confirm the current code does `scroll_into_view` before clicking Register, and that it verifies all 3 consents are checked before submit. Harden **only** if a real gap exists (e.g. no scroll-into-view, or submit fires before consents verified). Do not rewrite working logic.
**Done when:** Report shows the registration milestone set (with any new diffs) and a verdict on the Register-button/consent reliability (already-solid vs hardened-here).

### Task 3 — Close the fresh-account booking gap (ONLY if Task 1 found one)
**What to do — conditional:**
- **If Task 1 proved a fresh unlinked account books fine with `p1.png`:** do nothing here; note "no change needed."
- **If Task 1 found booking stalls for missing contact/profile data:** implement the **minimal** fix. Preferred options, least-invasive first:
  1. In the worker, fall back to the account's **own registered email + phone** (already in the DB row from registration) as `PROFILE_EMAIL`/`PROFILE_CONTACT` when no profile is linked — so contact steps have data without needing a linked profile.
  2. OR auto-attach a lightweight default profile (using `p1.png` + the account's registered contact) to freshly-registered accounts.
- Do NOT fabricate passport numbers; the passport identity comes from `p1.png` OCR. Only wire **contact** fallback data that already exists (the account's own registered email/phone).
**Done when:** Either "no change needed" with evidence, or a minimal diff that lets an unlinked fresh account complete booking, explained in the report.

### Task 4 — Keep the suite green (no live runs)
- `cd backend; npm test` → 166/166.
- `cd backend; npm run build` → exit 0.
- `python -m py_compile nodriver-spike/auto_pipeline.py nodriver-spike/register_spike.py` → clean.
**Done when:** all three pasted as evidence; fix anything your edits broke.

### Task 5 — Update `ARMED_RUN_RUNBOOK.md`: zero-state start
**What to add (a new section, keep the existing content):**
1. **Zero-state preconditions:** no VPN, clean UZ IP, `.env.worker` has `WORKER_TOKEN`/`DATABASE_URL`/`PROFILE_ENCRYPTION_KEY`/`MAILSAC_API_KEY`, `NOTIFY_BOOKING_FAILURES=true`, `passports/p1.png` present. **No pre-existing account needed.**
2. **The exact from-scratch launch** (from Task 1's cleanest trigger), e.g. ensure pool is empty / `POOL_MIN` forces one registration, then:
   ```powershell
   $env:SUBCAT='ocma'; $env:WORKER_BOOK='1'; .\launch-worker.ps1
   ```
   (Adjust per Task 1 findings — include whatever makes the worker register one fresh account and drive it to book.)
3. **Expected Telegram sequence from zero:** `register_started → registered → activated → logged in → no slots… → slot found → OTP requested → OTP filled → booked / payment wall`.
4. **The ~5-attempt registration throttle warning:** one clean run; if registration fails, do NOT retry-spam — diagnose first.
5. **Abort/watch + post-run cleanup** (cancel the test appointment) as before.
**Done when:** runbook has a self-contained "Start from scratch (zero state)" section.

---

## 3. Required output: `FROM_SCRATCH_PREP_REPORT.md`

```markdown
# From-Scratch Prep Report (<date>)

## TL;DR
Can the operator run from zero now? Yes/No + the single most important caveat.

## Task 1 — Zero-state chain trace
- The exact from-scratch trigger
- Fresh-account activation path
- FIELD-BY-FIELD verdict: is an unlinked fresh account bookable with only p1.png? (the key answer)

## Task 2 — Registration milestones + reliability
Milestone set, Register-button/consent verdict, any diffs.

## Task 3 — Fresh-account booking gap
"No change needed" (with evidence) OR the minimal fix + diff.

## Task 4 — Green suite
npm test / build / py_compile — pasted.

## Task 5 — Runbook
Confirm the zero-state section added.

## Open risks
OCMA slot availability, OTP delivery (email vs SMS), payment wall, registration throttle.

## What's staged (not committed)
File list.
```

**Evidence rule:** every readiness claim cites code location or command output.

---

## 4. Final step

Write `FROM_SCRATCH_PREP_REPORT.md`, update `ARMED_RUN_RUNBOOK.md`, then post in chat: the **Task 1 key answer** (is a fresh unlinked account bookable with only `p1.png`?) + the zero-state launch command + the top open risk. Then **stop** — the operator runs the live from-scratch chain; we QA the Telegram result together.
