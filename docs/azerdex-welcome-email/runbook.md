# Runbook — AzerDex welcome e-mail (deployment, operation, rollback)

**Nothing here is executed by the repository.** Every step is owner-run, first on an isolated hosted staging project (never the single live private project
for experiments), and requires the owner approvals in [acceptance.md](acceptance.md). Paths are relative to the repository root.

## 1. Prerequisites (do not skip)

1. Gate B-1: `https://azerdex.com/` is publicly reachable and useful (Vercel Deployment Protection / SSO not blocking it). If not, do not enable sending.
2. Gate G-2: re-run `database/tests/welcome/20_gotrue_provenance.test.mjs` logic against the hosted Auth version on staging (signup → confirm = 1 event; recovery on an unconfirmed signup = 0 events).
3. Asset: place the 128×128 PNG at `supabase/functions/azerdex-welcome-worker/azerdex-logo.png`.
4. Resend: domain `azerdex.com` verified (SPF/DKIM/DMARC); **open and click tracking OFF** for the domain; create a **sending-only** API key restricted to that domain.

## 2. Configure secrets (never in git, Vercel, web, Companion, addon, chat or logs)

```bash
# generate the invocation secret locally; do not echo it
umask 077; openssl rand -base64 48 > /dev/shm/azerdex_worker_secret
supabase secrets set --project-ref <STAGING_REF> \
  AZERDEX_WORKER_SECRET="$(cat /dev/shm/azerdex_worker_secret)" \
  RESEND_API_KEY="<sending-only key>"
# AZERDEX_WELCOME_ENABLED is deliberately NOT set (off). AZERDEX_WORKER_DB_KEY is optional; by default the platform-provided server key is used.
```

The server key can bypass RLS: it exists only as a Supabase secret read by this one function; the function can call exactly two RPCs (`azerdex_welcome_claim/_finish`) and has no SQL surface. Prefer a dedicated narrower credential if the project offers one.

## 3. Deploy (staging first)

```bash
supabase db push   # or apply database/migrations/0015_azerdex_welcome_outbox.sql with the migration role; switches stay OFF
supabase functions deploy azerdex-welcome-worker --project-ref <STAGING_REF>   # supabase/config.toml: verify_jwt = false (own secret check)
```
Verify unauthenticated invocation is refused: `curl -i -X POST https://<ref>.supabase.co/functions/v1/azerdex-welcome-worker` → `401 {"error":"unauthorized"}`.
Verify the migration's own post-conditions passed (it aborts otherwise) and run `database/ops/0015_welcome_monitoring.sql` (all counters 0, both switches false).

## 4. Schedule (still not sending)

```bash
psql "$STAGING_DB_URL" -v worker_secret="$(cat /dev/shm/azerdex_worker_secret)" \
  -v fn_url="https://<ref>.supabase.co/functions/v1/azerdex-welcome-worker" -f database/ops/0015_schedule_welcome_worker.sql
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
| rotate `AZERDEX_WORKER_SECRET` (set new secret; `vault.update_secret` for the cron job) | invalidates a leaked invocation secret |
| rotate `RESEND_API_KEY` | invalidates a leaked provider key |

Re-enable only after the cause is understood: `database/rollback/0015_kill_switch_restore.sql` (dispatch only; intake is a separate deliberate step).

## 7. Monitoring

`database/ops/0015_welcome_monitoring.sql` / `select public.azerdex_welcome_stats()` (service role). Alert when: `stale_pending_over_10m > 0`, `review_required > 0`,
`unknown_outcomes > 0`, `trigger_failures_open > 0`, `verified_not_enqueued > 0` for more than a few minutes, or the Edge Function log shows repeated `run_complete` with
`ambiguous`/`retry`. Alert text must carry **counts only**: no address, no user id. Function logs contain counts and allowlisted codes only (asserted by tests).

## 8. Investigating an unknown delivery outcome (`review_required`, `unknown_outcome = true`)

1. Identify the event (shortened id from the monitoring query). Look up the user's address **in `auth.users` as the owner, not in logs**.
2. In the Resend dashboard search that recipient + subject within the first-attempt window.
3. **A message exists** → `select private.azerdex_welcome_operator_resolve('<user_id>', true, '<resend id>');` (marks sent, erases the hash).
4. **No message exists** → `select private.azerdex_welcome_operator_requeue('<user_id>', true);` (new idempotency key, fresh attempts). The `true` is your explicit statement that the provider history shows nothing sent.
5. **Unsure / address no longer valid / user asked to stop** → `select private.azerdex_welcome_operator_resolve('<user_id>', false, null);` (suppressed).
Never re-send "just in case": a duplicate welcome is a worse outcome than a missed one. There is no public resend button.

## 9. Safe retry and recovery without duplicates

* `retry` rows retry themselves (same key, backoff, ≤ 6 attempts). Leave them.
* After an outage the queue drains by itself within its limits (10 per minute); events older than the idempotency window with an unknown outcome stop for review, not for re-send.
* If the database was restored from a backup, **do not** re-enable intake until you have compared `sent` rows with the provider's history; `sent` rows are the duplicate memory.
* Missed events (trigger failures) are reconciled automatically (≤ 50 rows, ≤ 7 days, only with proven provenance). There is **no backfill** for older accounts; welcoming them needs separate explicit owner approval.

## 10. GDPR / account deletion

Both event tables reference `auth.users ON DELETE CASCADE`: deleting an account (GoTrue admin or dashboard) erases its candidate, outbox row and failure markers. No separate
action is needed and an event for a deleted user can never be sent (the claim re-verifies the live account anyway). After a successful send the hashed recipient is erased immediately;
the row keeps only the user id, status, timestamps and the provider message id until the account is deleted. Resend retains its own delivery logs per its retention settings: handle erasure there too when required.
Welcome is transactional onboarding, not marketing consent.

## 11. Rollback

* Soft: kill switch (§6). Hard: `psql -f database/rollback/0015_rollback.sql` (triggers + functions; **tables kept** as duplicate memory) and, only when the data is not needed, `-v drop_data=1`.
  Dropping the triggers needs ownership of `auth.users` (run as the Auth owner role); with both switches OFF the triggers are inert.
* Re-apply later: the migration is idempotent and reuses kept tables. Ledger: record/remove the `azerdex_welcome_outbox` ledger entry consistently with how the migration was applied.
