# Runbook — AzerDex welcome e-mail (deployment, operation, rollback)

**Nothing here is executed by the repository.** Every step is owner-run, first on an isolated hosted staging project (never the single live private project
for experiments), and requires the owner approvals in [acceptance.md](acceptance.md). Paths are relative to the repository root. The staging setup/validation/teardown, costs and the one owner decision it needs are in [staging-plan.md](staging-plan.md).

## 1. Prerequisites (do not skip)

1. Gate B-1: `https://azerdex.com/` is publicly reachable **for an anonymous visitor** and useful. The domain is assigned and verified, but Vercel Authentication (SSO) protects all deployments of the project; confirm from a logged-out browser (`curl -sI https://azerdex.com/` → 200, not 401/login redirect). Changing protection needs owner approval. If not satisfied, do not enable sending.
2. Gate G-2: run `node scripts/azerdex-welcome-hosted-provenance.mjs` against the **hosted staging** Auth ([staging-plan.md §5](staging-plan.md)); PASS = exit code 0 with S1–S5 **and S7** (needs `ANON_KEY`) `pass: true` and the cleanup report restored (S6 is informational). The harness deletes every synthetic user it creates.
3. Asset: the emblem is committed (`azerdex-logo.png`) **and embedded** in the function's import graph (`logo-data.ts`, regenerate with `node scripts/embed-azerdex-logo.mjs` after any change to the PNG; the test suite fails if it is stale). Any deploy path works. Hosted G-7 passes **only** when an authorized invocation answers `state: ok` with the worker flag **on** and dispatch **OFF** (the emblem is validated before the queue is touched); `disabled` only proves authentication and the flag, it says nothing about the emblem; `logo_invalid` is a failure.
4. Resend: **G-4 PASS** (template + CID proven directly, owner test 2026-10-16, Gmail desktop). Domain `azerdex.com` verified, sending enabled, **open and click tracking OFF** — *owner-attested 2026-10-14 (G-5 PASS, not independently verifiable from this repository; re-check in the dashboard before first send)*. Create a **sending-only** API key restricted to that domain.

## 2. Configure secrets (never in git, Vercel, web, Companion, addon, chat or logs)

```bash
# generate the invocation secret locally; do not echo it
umask 077; openssl rand -base64 48 > /dev/shm/azerdex_worker_secret
supabase secrets set --project-ref <STAGING_REF> \
  AZERDEX_WORKER_SECRET="$(cat /dev/shm/azerdex_worker_secret)" \
  RESEND_API_KEY="<sending-only key>"
# Recommended: AZERDEX_WELCOME_MODE=template (G-4 proved it directly; see resend-integration.md). AZERDEX_WELCOME_ENABLED is deliberately NOT set (off). AZERDEX_WORKER_DB_KEY is optional; by default the platform-provided server key is used.
```

The server key can bypass RLS: it exists only as a Supabase secret read by this one function; the function can call exactly two RPCs (`azerdex_welcome_claim/_finish`) and has no SQL surface. Prefer a dedicated narrower credential if the project offers one.

## 3. Deploy (staging first)

```bash
# Apply the migration with the project's migration role (needs BYPASSRLS, TRIGGER+REFERENCES on auth.users, SELECT on auth.one_time_tokens; the
# migration's pre-flight checks this). This repository keeps migrations under database/migrations/, so `supabase db push` does NOT pick it up:
psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f database/migrations/0015_azerdex_welcome_outbox.sql     # switches stay OFF
supabase functions deploy azerdex-welcome-worker --project-ref <STAGING_REF>   # supabase/config.toml: verify_jwt = false (own secret check); no static files needed
```
Verify unauthenticated invocation is refused: `curl -i -X POST https://<ref>.supabase.co/functions/v1/azerdex-welcome-worker` → `401 {"error":"unauthorized"}`.
Verify the migration's own post-conditions passed (it aborts otherwise) and run `database/ops/0015_welcome_monitoring.sql` (all counters 0, both switches false).

## 4. Schedule (still not sending)

```bash
# the script reads the secret from /dev/shm/azerdex_worker_secret itself (never put it on a command line: it would show in the process list)
psql "$STAGING_DB_URL" -v fn_url="https://<ref>.supabase.co/functions/v1/azerdex-welcome-worker" -f database/ops/0015_schedule_welcome_worker.sql
shred -u /dev/shm/azerdex_worker_secret
```
The cron job runs every minute; while the worker flag is unset it answers `{"state":"disabled"}` and does nothing.

## 5. Start sending (two explicit approvals: infrastructure rollout, then first real recipient)

1. `select private.azerdex_welcome_set_switch(true, null);` — intake ON: records `activation_at` (accounts registered earlier can **never** become candidates).
2. Register a test account **with an owner-controlled address**; confirm it. Expect one `pending` row (`database/ops/0015_welcome_monitoring.sql`).
3. `select private.azerdex_welcome_set_switch(null, true);` and `supabase secrets set AZERDEX_WELCOME_ENABLED=true`.
4. Within ~1–2 minutes: one `sent` row with a provider id; the message arrives with the emblem inline, text part, Reply-To `support@azerdex.com`.
5. Repeat the confirmation link, log in, request a password reset: **no second mail** (acceptance A-3).

## 6. Stop (kill switch) — fastest first

| Action | Effect |
| --- | --- |
| `psql -f database/rollback/0015_kill_switch.sql` | intake and dispatch OFF at once, rows preserved, accounts unaffected |
| `supabase secrets set AZERDEX_WELCOME_ENABLED=false` | worker refuses to claim (nothing consumed) |
| `psql -f database/ops/0015_unschedule_welcome_worker.sql` | stop invocations |
| rotate `AZERDEX_WORKER_SECRET`: `supabase secrets set` the new value **and** `select vault.update_secret((select id from vault.secrets where name='azerdex_worker_secret'), '<new>');` (the scheduler script only creates, never updates) | invalidates a leaked invocation secret |
| rotate `RESEND_API_KEY` | invalidates a leaked provider key |

Re-enable only after the cause is understood: `database/rollback/0015_kill_switch_restore.sql` (dispatch only; intake is a separate deliberate step).

## 7. Monitoring

`database/ops/0015_welcome_monitoring.sql` / `select public.azerdex_welcome_stats()` (service role). Alert when: `stale_pending_over_10m > 0`, `review_required > 0`,
`unknown_outcomes > 0`, `trigger_failures_open > 0` (`signup_trigger_failures_open` = a user whose candidate was lost: they will not be welcomed; this is fail-safe), `verified_not_enqueued > 0` for more than a few minutes, or the Edge Function log shows repeated `run_complete` with
`ambiguous`/`retry`. Alert text must carry **counts only**: no address, no user id. Function logs contain counts and allowlisted codes only (asserted by tests).

**Provider key / domain problem:** the worker log event `provider_auth_failed` (and `state: provider_auth_failed` in the response) means Resend answered 401/403. No user is parked; jobs are released with their attempt given back and looked at again about every 5 minutes until you fix the key or domain verification. Alert on this event.

**Changing the sending mode (`AZERDEX_WELCOME_MODE` html ↔ template):** only with an empty retry queue. `select public.azerdex_welcome_stats()` must show **no** `retry` and **no** `leased` rows (or wait 24 h): the idempotency key is the same in both modes, so a changed payload under a reused key is answered 409 by the provider and the event would burn attempts and end in `review_required` (resend-integration.md). Never edit or unpublish the `azerdex-welcome-v1` template while events are in flight; a template-wide mistake parks at most 3 users per run: fix the template, then `operator_requeue` them.

## 8. Investigating an unknown delivery outcome (`review_required`, `unknown_outcome = true`)

1. Identify the event (shortened id from the monitoring query). Look up the user's address **in `auth.users` as the owner, not in logs**.
2. In the Resend dashboard search that recipient + subject within the first-attempt window.
3. **A message exists** → `select private.azerdex_welcome_operator_resolve('<user_id>', true, '<resend id>');` (marks sent, erases the hash).
4. **No message exists** → `select private.azerdex_welcome_operator_requeue('<user_id>', true);` (new idempotency key, fresh attempts). The `true` is your explicit statement that the provider history shows nothing sent.
(A `suppressed` event cannot be requeued: its address hash was erased. If a genuinely verified user must be welcomed after all, that is a new, separately approved action, not a retry.)
5. **Unsure / address no longer valid / user asked to stop** → `select private.azerdex_welcome_operator_resolve('<user_id>', false, null);` (suppressed).
Never re-send "just in case": a duplicate welcome is a worse outcome than a missed one. There is no public resend button.

## 9. Safe retry and recovery without duplicates

**Provider outage or quota exhaustion (429/5xx for hours):** each retry consumes an attempt (cap 6, backoff 1…16 min), so a long outage parks queued events as `review_required` with `last_error_code = 'attempts_exhausted'`. Prevent it by switching dispatch OFF (`0015_kill_switch.sql`: no attempts are consumed) when you see sustained 429/5xx or a provider status incident. Recover afterwards: events parked with `attempts_exhausted` **and `unknown_outcome = false`** only ever saw definite non-sends (429, released attempts), so they can be requeued in bulk without a provider-history check:
`select private.azerdex_welcome_operator_requeue(user_id, true) from private.azerdex_welcome_outbox where status = 'review_required' and last_error_code = 'attempts_exhausted' and not unknown_outcome;`
Rows with `unknown_outcome = true` still need the per-event provider check (§8). Alert on `review_required > 0`.


* `retry` rows retry themselves (same key, backoff, ≤ 6 attempts). Leave them.
* After an outage the queue drains by itself within its limits (10 per minute); events older than the idempotency window with an unknown outcome stop for review, not for re-send.
* If the database was restored from a backup, **do not** re-enable intake until you have compared `sent` rows with the provider's history; `sent` rows are the duplicate memory.
* Missed events (trigger failures) are reconciled automatically (≤ 50 rows, ≤ 7 days, only with proven provenance). There is **no backfill** for older accounts; welcoming them needs separate explicit owner approval.

## 10. GDPR / account deletion

Both event tables reference `auth.users ON DELETE CASCADE`: deleting an account (GoTrue admin or dashboard) erases its candidate, outbox row and failure markers. No separate
action is needed and an event for a deleted user can never be sent (the claim re-verifies the live account anyway). After a successful send the hashed recipient is erased immediately;
the row keeps only the user id, status, timestamps and the provider message id until the account is deleted. **GoTrue soft-delete** (`deleted_at` set, row kept) does not fire the cascade: the claim then suppresses and zeroes the hash, but the user id and provider message id stay until the row is hard-deleted; use hard deletion for erasure requests. Resend retains its own copy of the recipient and message: **erase it in the Resend dashboard/API (delete the message log or request erasure) as part of every GDPR deletion.** Candidate rows (with an address hash) exist only between signup and verification and are deleted when the outbox row is created or after 30 days.
Welcome is transactional onboarding, not marketing consent.

## 11. Rollback

* Soft: kill switch (§6). Hard: `psql -f database/rollback/0015_rollback.sql` (triggers + functions; **tables kept** as duplicate memory) and, only when the data is not needed, `-v drop_data=1`.
  Dropping the triggers needs ownership of `auth.users` (run as the Auth owner role); with both switches OFF the triggers are inert.
* Re-apply later: the migration is idempotent and reuses kept tables. Ledger: record/remove the `azerdex_welcome_outbox` ledger entry consistently with how the migration was applied.
