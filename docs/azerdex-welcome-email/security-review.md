# Independent reviews (security and code quality)

Two reviewers, started without the author's conclusions, read the code read-only (2026-10-13). Their findings, and what was done:

## Security review — no high-severity issue; no requirement could be broken

Checked and found sound: forced RLS + no grants on all four tables, sequence and schema ACLs; 12 SECURITY DEFINER functions with `search_path=''`, only the three RPCs executable and only by `service_role`; no recipient or free-text parameter; eligibility never reads `user_metadata`; recovery / e-mail change / repeated confirmation / login cannot create an event; status machine (no path that sends twice or resurrects `sent`/`suppressed`); triggers have no I/O and cannot raise; worker auth is constant-time and precedes everything; no SSRF; logs carry counts and allowlisted codes only.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | medium | Revoked/restricted Resend key (401/403) parked one user per minute in `review_required` | **Fixed**: auth failure is a run-level stop; all claimed jobs released with the attempt given back; `provider_auth_failed` log/state; tests WT-14b |
| 2 | medium | Logo PNG probably not bundled into the deployed function | **Fixed (config) + gated** — *superseded in Round 3: `static_files` cannot be shipped by API-based deploys, so the emblem is now embedded in the import graph and `static_files` was removed*; hosted G-7 check remains |
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
| 6 | `static_files` | Fixed — *superseded in Round 3 (embedded emblem; no `static_files`)* |
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

## Round 2 — final review of the updated head (`8b3abe7`, emblem + bundle regression + account-test isolation)

**Security reviewer: no high or medium finding.** Re-verified from scratch: no enqueue/edit/read path for anon, authenticated or other users; provenance (recovery links keep `recovery_sent_at`; e-mail change leaves `confirmation_token`; invites/anonymous excluded; only false negatives); worker auth and leakage; no double send inside or after the idempotency window; scheduler secret handling. The emblem is a plain 128×128 8-bit palette PNG with only IHDR/PLTE/tRNS/IDAT/IEND chunks, valid CRCs, no trailing bytes, sha256 matches.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | low | Scheduler script interpolates the secret into SQL text; a failed `cat` stores an empty secret | **Fixed**: length ≥ 32 guard, abort otherwise; statement-log caveat documented in the script |
| 2 | low | `operator_requeue` accepted `suppressed` rows whose hash is erased (could never send; misleading) | **Fixed**: only `review_required`; WK-23 asserts it |
| 3 | low | `denoland/setup-deno@v2` tag-pinned, Deno version floating | **Partly fixed**: Deno version pinned (2.9.6). The action stays tag-pinned like every workflow in this repo (SHA-pinning repo-wide is a separate change) |
| 4 | low | Deno permission flags broader than needed; probe-port race | **Fixed**: `--allow-net` limited to the two ports, `--allow-env` to the 8 names. Port race (rare) accepted |
| info | | provenance reads GoTrue internals (fails closed); emblem presence in the *hosted* bundle unproven; worker URL internet-reachable without rate limit | Documented: G-2, G-7 (hosted), `verified_not_enqueued` alert in the runbook |

**Integration/evidence auditor:** scope clean (nothing outside `database/`, `supabase/`, `tests/welcome-worker/`, `docs/`, the welcome workflow; the only existing test file touched is `database/tests/account/01_privileges.test.mjs`, one signature-exact exclusion, not edited on #56); `git merge-tree` against #56 merges clean (only `docs/ROADMAP.md`, different hunks); 0014 and 0015 do not collide (0014 writes nothing on `auth.users`, no triggers). Documentation contradictions it listed (stale Vercel facts, G-1/G-5/G-7 statuses, 218/219 and "unchanged" claims, counts, dangling reference) were **corrected**; test gaps (AS-3 regex also matched a commented-out entry; no PNG chunk/CRC walk) were **fixed** (AS-1b; mutation-checked: commenting out `static_files` fails AS-3). *(Historical, Round 2: at that time no suite applied 0014 and 0015 together; since the account chain landed in `main` both orders are tested, see Round 3 and acceptance.md.)*

## Round 3 — final review of the post-G-4 head (`f8d4349`: merge of `main`, embedded emblem, template-mode tests, hosted-staging preparation)

**Security reviewer: no high finding.** Verified from scratch: no anon/authenticated/other-user path to enqueue, edit or read outbox data or to choose a recipient; confirm-trigger provenance vs recovery / e-mail change / login (only false negatives); worker auth; double-send windows; the new CRC walk in `logo.ts` (bounds-checked, bounded by the 16 KiB cap); the generated `logo-data.ts` (plain PNG, IHDR/PLTE/tRNS/IDAT/IEND, hash equals the pin); `0015_staging_verification.sql` (read-only); `0015_record_migration_ledger.sql` (insert-only); `supabase/config.toml`; CI permissions and secrets.

| # | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| 1 | medium | Hosted provenance harness left synthetic users with `pending` outbox rows that could poison the first real dispatch; dispatch only checked once | **Fixed**: the harness deletes every user it creates (also after failure), re-checks dispatch before each scenario, and reports `cleanup` (created = deleted, outbox restored); verified locally: 7 created / 7 deleted / restored |
| 2 | low | Production guard weaker than it read (unvalidated ref, substring host checks, `REST_URL` loose, no `https` requirement) | **Fixed**: 20-char ref format, `https`, both hostnames exactly `<ref>.supabase.co`, no port/credentials, production ref refused on the parsed host, key `ref` claim must match; loopback needs `STATS_MODE=pg`, loopback `PGHOST`, `fdb_*` database. Negatives tested (7 refusals) |
| 3 | low | Worker did not validate the recipient string passed to Resend | **Fixed**: plain ASCII addr-spec only; anything else is parked as `permanent` without calling the provider and without counting toward the breaker (WT-15b). Consequence: IDN/quoted addresses are not welcomed in V1 |
| 4 | low | A long provider 429/5xx/quota outage consumes attempts and can park the queue as `attempts_exhausted` | **Accepted + operationalised**: no double-send risk. Runbook §9: switch dispatch OFF during sustained provider trouble (no attempts consumed); parked rows with `attempts_exhausted` and `unknown_outcome = false` only saw definite non-sends and can be bulk-requeued without a provider check; alert on `review_required` |
| 5 | low | Scheduler script did not validate `fn_url` (secret goes there every minute); Vault copies not removed on teardown | **Fixed**: the script accepts only `https://<20-char-ref>.supabase.co/functions/v1/azerdex-welcome-worker` (regex verified); the unschedule file documents the deliberate Vault teardown |
| info | | PNG validator accepted any ancillary chunk and did not require IHDR length 13 / IDAT before IEND | **Fixed**: IHDR length, IDAT-before-IEND and empty IEND enforced (tests); ancillary chunks remain bounded by the size cap and the hash pin |

**Integration/evidence auditor: no code bug.** Scope clean (nothing outside `database/`, `supabase/`, `scripts/`, `tests/welcome-worker/`, `docs/`, the welcome workflow; the one existing test file edited is the signature-exact exclusion in `database/tests/account/01_privileges.test.mjs`); 0014 and 0015 do not collide; the enrollment-suite exclusion expression is correct on GitHub runners. Findings fixed in this round:
`disabled` had been presented as a G-7 pass (now only `state: ok` with the flag on and dispatch OFF counts); stale text treating the account chain as unmerged / `0014` as reserved (plan, ROADMAP, migration header comment); stale "static_files fixed" lines (marked superseded above); the "flake on main" claim was unsupported in CI terms (reworded as *observed locally*, not a statement about `main`'s CI); the G-2 pass criterion was unachievable as written (S6 is now informational; PASS needs S1–S5 and S7 with `ANON_KEY`); retry timing after a provider auth failure (about every 5 minutes, not every minute); `permanent` was miscounted on the provider-auth path (fixed); ROADMAP lacked the G-4 limits sentence (added); the no-file-read test scanned only `index.ts` (now every worker source).
