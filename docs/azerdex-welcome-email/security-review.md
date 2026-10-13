# Independent reviews (security and code quality)

Two reviewers, started without the author's conclusions, read the code read-only (2026-10-13). Their findings, and what was done:

## Security review — no high-severity issue; no requirement could be broken

Checked and found sound: forced RLS + no grants on all four tables, sequence and schema ACLs; 12 SECURITY DEFINER functions with `search_path=''`, only the three RPCs executable and only by `service_role`; no recipient or free-text parameter; eligibility never reads `user_metadata`; recovery / e-mail change / repeated confirmation / login cannot create an event; status machine (no path that sends twice or resurrects `sent`/`suppressed`); triggers have no I/O and cannot raise; worker auth is constant-time and precedes everything; no SSRF; logs carry counts and allowlisted codes only.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | medium | Revoked/restricted Resend key (401/403) parked one user per minute in `review_required` | **Fixed**: auth failure is a run-level stop; all claimed jobs released with the attempt given back; `provider_auth_failed` log/state; tests WT-14b |
| 2 | medium | Logo PNG probably not bundled into the deployed function | **Fixed (config) + gated**: `static_files` added to `supabase/config.toml`; staging smoke test G-7 (cannot be proven without a deploy) |
| 3 | low | 180 s lease not enforced: no timeout on RPC calls; abort timer cleared before the response body is read | **Fixed**: 10 s `AbortSignal` on RPC calls, one signal over headers+body for Resend, 90 s run budget; WT-9b, WT-22 |
| 4 | low | Hash/personal-data retention broader than claimed; soft-delete doesn't cascade | **Fixed**: candidate deleted once outbox row exists; hash zeroed on suppression/operator decision; docs state soft-delete limitation and Resend-side erasure (WK-22, runbook §10) |
| 5 | low | `circuit_open` give-back started the idempotency clock; unbounded churn | **Fixed (clock)**: `first_send_at` reset when no real attempt (WK-23). Churn is harmless (nothing sent) and alertable; accepted |
| 6 | low | `operator_requeue` allowed from `retry` | **Fixed**: only `review_required`/`suppressed` (WK-23) |
| 7 | low | Signup-phase trigger failures invisible | **Fixed (visibility)**: `signup_trigger_failures_open` counter; the user is fail-safe not welcomed |
| 8 | low | Third party can suppress a welcome via `/recover` on an unconfirmed address | **Accepted** (probe scenario J; false negative only), documented |
| 9 | low | Secret passed as a `psql -v` argument (process list) | **Fixed**: script reads `/dev/shm` file via `\set … \`cat\``; runbook updated |
| 10 | info | Owner role needs BYPASSRLS; GoTrue-internals dependency; 409 `invalid_idempotent_request` after payload change | **Fixed/documented**: pre-flight asserts BYPASSRLS; gate G-2; resend-integration table |

## Code-quality review — no blocking defect in SQL; fixes applied

| # | Finding | Resolution |
| --- | --- | --- |
| 1–2 | timeout did not cover body; RPC calls had no timeout / run budget | Fixed (see security #3) |
| 3 | provider auth burns one event per run | Fixed (security #1) |
| 4 | `stack.sh` masked a failing migration | Fixed (`client_min_messages=warning`, no pipe); same in the workflow |
| 5 | rollback script: no `ON_ERROR_STOP`, impossible non-owner path, not re-runnable | Fixed: `ON_ERROR_STOP`, guarded switch-off, honest ownership note (no half-rollback offered), re-run safe; RB-2/RB-3 |
| 6 | `static_files` | Fixed |
| 7 | 2xx≠200/201, 408/423/425 classified permanent | Fixed → ambiguous; WT-8 |
| 8 | `MAX_PER_RUN=0` meant 10 | Fixed → 1 |
| 9 | `startsWith("http://localhost")` accepts `localhost.evil.com` | Fixed: URL parsed, exact host; WT-2 |
| 10–13 | body cancel, fetch `this`, logging on claim failure, `state` on last-job trip, jobs beyond the cap left leased | Fixed (WT-14c, WT-16) |
| 14 | low-value status index | Removed |
| 15 | weak prune test | Replaced (WK-21) |
| 16 | scheduler secret only created, never updated | Documented in script and runbook (rotation) |
| docs | broken `acceptance.md`/`security-review.md` links; spec link; "eleven functions"; `supabase db push` wrong; probe rows D/G confusing; resend table contradictions | Fixed (this directory, plan, ROADMAP, migration header) |
| tests | RB-4 vacuous; missing backoff, claim-time cap, auth-across-runs, body-stall tests | Added WK-24, WK-25, WT-9b, WT-14b; RB-4 now asserts the trigger set |

Still not covered by any test (stated, not hidden): an owner role without BYPASSRLS at run time (guarded by the pre-flight only), a deployed `Deno.serve` + bundled static asset, hosted GoTrue/Auth behaviour, real Resend.

Re-run after the fixes: worker unit 25/25; SQL/GoTrue suites 67/67; mutation check OK (see [acceptance.md](acceptance.md)).
