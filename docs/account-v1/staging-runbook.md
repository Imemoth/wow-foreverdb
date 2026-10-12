# Account System V1 — staging deployment and acceptance runbook (owner-run)

**Nothing in this document was performed by the PR that added it.** Every step that creates a resource, changes a setting, applies a migration or bills needs the owner's explicit approval. Use a **separately created, owner-approved Supabase project**; never the production project `klxhikdlfwgxurdyexdi`. Evidence states stay separate: finishing this runbook is what may later move capabilities to **STAGING VERIFIED**; it never implies WINDOWS VERIFIED or PRODUCTION APPROVED.

## 1. Create and prepare (approval required)

1. Create the staging project (record its 20-character ref). Record the project's Auth (GoTrue) and PostgREST versions and settings from the dashboard/support (they are managed by Supabase).
2. Auth settings, record each with a dated screenshot/export: **Confirm email ON**; **Anonymous sign-ins enabled**; refresh-token rotation ON; **CAPTCHA project-wide OFF** (the Companion cannot satisfy it); single-session-per-user OFF; session time-box OFF; short inactivity timeout OFF; leaked-password protection on; custom SMTP with SPF/DKIM/DMARC; confirmation and recovery templates linking to `{{ .SiteURL }}/account/auth/confirm?token_hash={{ .TokenHash }}&type=email|recovery`; Site URL and redirect allow list = the exact preview callback only.
3. Vercel **Preview** environment only (never Production): `ACCOUNT_AUTH_MODE=staging`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_PROJECT_REF`, `ACCOUNT_AUTH_PUBLISHABLE_KEY` (publishable/anon only), `ACCOUNT_CSRF_SECRET` (>= 32 random chars), `RATE_LIMIT_BACKEND=upstash` + Upstash URL/token, Turnstile site + secret key, `SITE_URL` = the preview origin. Production Branch stays `release`; Vercel Authentication stays on.

## 2. Database (approval required, staging project only)

Pre-flight through `0012`'s own pre-flight; apply in this order and no other: the existing chain through `0009`, then `0011`, then `0012_account_ownership_claims.sql` ([0012-deployment-and-recovery.md](0012-deployment-and-recovery.md)). `0010` is reserved and not a prerequisite. **`0013` is recovery-only** after a recorded full `0012` rollback and its ledger entry: never part of setup. Record the migration ledger readback.

## 3. Settings the integrated CI cannot prove (check on staging and record)

| Check | Why |
| --- | --- |
| PostgREST `db-tx-end` is `commit` (not `commit-allow-override`) | with the override, `Prefer: tx=rollback` un-counts wrong guesses; repeat scenario 27 against the hosted gateway, including the `Prefer` header |
| Hosted Auth/PostgREST versions vs the CI stack (GoTrue `v2.197.0` @ `4eee58f2…`, PostgREST `v12.2.12`); PostgREST error codes (`PGRST301` vs `PGRST303` for an expired JWT) | record the difference; expectations in `03-postgrest.spec.ts` are version specific |
| New-style `sb_publishable_` key + the user JWT in `Authorization` through the real gateway for `/rest/v1/rpc/*` | CI uses a locally minted anon JWT and a pass-through shim; a gateway 401 is shown as "signed out" by the website |
| Hosted grants and default privileges: repeat test 30 (private tables unreachable for anon and other accounts) incl. `observed_loot_stats`, and the `graphql` surface | the CI harness has stricter default grants than Supabase |
| Hosted `authenticated` statement timeout vs the website's 8 s redemption timeout | a slow redeem would surface as "outcome unknown" |
| Hosted JWT signing (symmetric vs asymmetric keys) | CI uses HS256 with a shared secret |
| Real SMTP delivery, SPF/DKIM/DMARC pass, inbox placement | CI uses Mailpit |
| Session independence under the final settings (Companion anonymous + registered + web at once), AT-4 | proves CAPTCHA/session-coupling settings are really off |

## 4. Acceptance sequence (staging preview + test accounts + throwaway mailbox)

Run the integrated scenarios 1-30 of [integration-and-acceptance-report.md](integration-and-acceptance-report.md) by hand or by pointing the Playwright suite's helpers at staging (not automated by CI): register and confirm A and B; an anonymous Companion identity (Windows machine, `FOREVERDB_ACCOUNT_MODE=staging`, W-checklist); claim; website redemption with the password; cap, replay, concurrency, rate limits, logout independence, recovery, isolation, history hashes. Then the **owner-only abuse gates**: L-1..L-8, M-1..M-8, AT-1..AT-7, A24 direct-GoTrue abuse (website Turnstile does **not** count), shared-egress attribution (L-8/AT-7), claim DoS ceilings (global redeem bucket: [security.md §6](security.md)), audit retention and pruning, alert routing and an incident rehearsal.

## 5. Evidence to hand back

Project ref (not keys), settings exports, ledger readback, version comparison, run logs for §3/§4 with timestamps, the L/M/AT tables, and the Windows checklist. Only then may the owner mark individual items STAGING VERIFIED in the report; production stays BLOCKED until a separate written approval.
