# Hosted staging plan — AzerDex welcome e-mail (G-2, G-3, G-7 hosted)

**Status: PLAN ONLY. Nothing here has been executed.** No staging project exists, none was created, and creating one needs the owner's explicit approval
(see §3). All facts below come from **read-only** discovery on 2026-10-16 (Supabase MCP: organizations, projects, branches, functions, ledger; current Supabase
docs) and are labelled as such. The private/production project `wow-forever` (`klxhikdlfwgxurdyexdi`) is **never** used for these checks.

## 1. Discovery (read-only, 2026-10-16)

| Fact | Evidence |
| --- | --- |
| Organization `Hearth & Byte`, plan **free** | `get_organization` |
| Projects: `wow-forever` (eu-west-1, ACTIVE_HEALTHY, PG 17) = the private/production project; `PetUtopia`, `FitTracker`, `BudgetCalc` = **INACTIVE, unrelated, not to be reused** | `list_projects` |
| **No AzerDex staging project exists** | `list_projects` |
| `wow-forever`: one branch (`main`), **no deployed Edge Functions** | `list_branches`, `list_edge_functions` |
| Production ledger records `0014` as `20261013112920 zero_touch_enrollment` (resolves the earlier "owner to record the 0014 ledger version" item); `0015` is **not** applied | `list_migrations` (read-only) |
| Free plan: **two active free projects** (paused ones do not count); free projects are **auto-paused after ~7 days of low activity** (restorable for 90 days) | Supabase docs: Billing, Project Pausing |
| **Preview branching requires the Pro plan**; a branch is not a fixed fee: Micro compute starts at **$0.01344/h** (≈ $0.32/day, ≈ $9.7/month if left running), **outside the spend cap**; the Pro plan itself is $25/month for the whole organization | Supabase docs: Manage Branching usage, Deployment & Branching |
| Edge Functions: free quota 500,000 invocations/month (a 1-minute scheduler = ~43,200/month) | Supabase docs: Billing |
| Scheduling: `pg_cron` + `pg_net` + Vault is the documented pattern | Supabase docs: Scheduling Edge Functions |
| **Static files are not shipped by API-based deploys** (CLI ≥ 2.7.0 with Docker only) | Supabase docs: Wasm modules / bundling note. **Consequence: the emblem is now embedded as a generated module (`logo-data.ts`), so every deploy path bundles it** |
| Default Auth SMTP **only sends to pre-authorized addresses** (team members), rate-limited, "best effort / non-production" | Supabase docs: Auth SMTP |

`0015` is independent of `0014`: no shared object names, neither writes the other's tables; proven in **both** orders by the local suites (welcome suites on
`0012 → 0014 → 0015`; Account suite 219/219 and the enrollment suite on `0012 → 0015 → 0014`, with one pre-existing flaky enrollment test excluded, see acceptance).

## 2. Options and recommendation

| Option | Cost | Isolation | Notes |
| --- | --- | --- | --- |
| **A. New FREE project in the existing org** (recommended) | **$0** while within free quotas | separate DB, Auth, functions, secrets, keys | fits the "two active free projects" limit (currently one active). Auto-pauses after ~7 days idle: acceptable for staging; resume before each session. 500 MB DB is ample. |
| B. New FREE project in a separate free org | $0 | strongest billing/ownership separation | counts toward the same per-owner free-project limit |
| C. Pro plan + Preview branch of `wow-forever` | $25/month plan (org-wide, would also change the production project's plan) + ~$0.32/day per branch, not spend-capped | schema copy only, **no data** | needs an org upgrade and spend decision; migrations run from the repo on branch creation. Not recommended for a first staging. |

**Proposed project:** name `azerdex-welcome-staging`, org `Hearth & Byte`, plan free, region **eu-west-1** (same as `wow-forever`, for platform parity), default Postgres.
**Expected cost: $0.** Teardown (§7) returns to the current state.

## 3. Owner decision requested (the only one)

> Approve creation of **one free Supabase project** `azerdex-welcome-staging` in org `Hearth & Byte`, region eu-west-1, **$0**, to be deleted after acceptance.

Without it nothing else here can proceed. If the owner prefers C (Pro + branch), say so; that is billable and needs explicit cost approval.

## 4. Setup order (once approved; secrets by NAME only)

1. Create the project (dashboard). Record its ref in a private note; **never** reuse `klxhikdlfwgxurdyexdi`. Set staging Auth: email confirmations **ON**, anonymous sign-ins as on production (the Companion uses them).
2. Apply migrations in ledger order with the owner migration role, each followed by its ledger record if applied with psql (`database/ops/*_record_migration_ledger.sql`; 0015 uses `database/ops/0015_record_migration_ledger.sql`):
   `0001 … 0006`, `database/sql/search_location_api.sql`, `0008`, `0008a`, `0008b`, `0009`, `0011`, `0012`, `0014`, then **`0015`** (switches OFF). (The minimal alternative for a quick 0015-only check is `0001` + `0015`; the full chain is required for G-3 because production has it.)
3. `psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f database/ops/0015_staging_verification.sql` → must print `OK` (privileges, RLS, 12 functions, triggers).
4. PostgREST-layer authorization probes (expect every one denied except the last), using the staging URL and keys read from the environment:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST "$STAGING_REST/rpc/azerdex_welcome_claim" -H "apikey: $ANON_KEY" -H 'content-type: application/json' -d '{}'` → 401/403/404;
   the same with `Authorization: Bearer <access token of an anonymous sign-in>` → 401/403 (permission denied); `…/rpc/azerdex_welcome_stats` likewise; with the server key → 200.
   Also `curl "$STAGING_REST/azerdex_welcome_outbox"` → 404 (the schema is not exposed).
5. Secrets (Edge Function secrets, names only): `AZERDEX_WORKER_SECRET`, `RESEND_API_KEY`, `AZERDEX_WELCOME_MODE`; **not set**: `AZERDEX_WELCOME_ENABLED`. Optional `AZERDEX_WORKER_DB_KEY`. The Resend key: the owner decides which key to use for staging; **no key is created, rotated or revoked by this plan**.
6. Deploy the function to staging only: `supabase functions deploy azerdex-welcome-worker --project-ref <STAGING_REF>` (any deploy path now works: the emblem is in the import graph). Unauthenticated POST → 401. Authorized POST with the flag unset → `{"state":"disabled"}`.
7. Schedule: `database/ops/0015_schedule_welcome_worker.sql` (still inert while the flag is unset).

## 5. Validation

**G-7 (hosted)** — authorized invocation after enabling the flag must answer `state: ok` (queue empty), **never** `logo_invalid`; response size/time sane; function logs show `run_complete` with `mode`. A corrupted bundle cannot be simulated hosted; it is proven by the local Deno test (AS-6).

**G-2 (hosted GoTrue provenance)** — drive the matrix without sending mail, with the harness (staging only; refuses the production ref):
```
export AUTH_URL="https://<ref>.supabase.co/auth/v1" REST_URL="https://<ref>.supabase.co/rest/v1" FDB_STAGING_REF="<ref>"
export SERVICE_KEY="…" ANON_KEY="…"      # read from your password manager, never written to a file or command line
# precondition on STAGING: select private.azerdex_welcome_set_switch(true, null);  -- intake ON, dispatch stays OFF
node scripts/azerdex-welcome-hosted-provenance.mjs
```
Scenarios S1–S7 (signup confirm = 1 event; repeat = none; recovery on an unconfirmed signup = none; recovery of a confirmed account = none; recovery-before-signup-link = none; e-mail change = none; anonymous = none). **PASS only if the exit code is 0 and no scenario is `inconclusive`**; `inconclusive` (e.g. an `email_change` verify that needs both confirmations) must be repeated manually with real mail to an owner-controlled team address. If any expectation fails the rule does **not** hold on the hosted Auth: **stop, keep sending disabled** and report (the rule fails closed by design: a hosted difference normally shows as *zero* events in S1, not extra events). The harness is validated against the local real-GoTrue stack only (5 pass, 0 fail, 2 inconclusive/skipped).
Also capture the hosted Auth version (dashboard → Infrastructure) in the evidence.

**G-3 (hosted integration)** — with dispatch still OFF: switches, privileges (step 3–4), denied anonymous invocation, kill switch (`0015_kill_switch.sql` / restore), reconciler (`select private.azerdex_welcome_reconcile()` after a simulated trigger failure is covered by local PV-14; hosted: confirm `azerdex_welcome_stats()` counters). Lease/retry/idempotency/unknown-outcome behaviour is database logic proven locally (WK-1…WK-26, E2E-1…8); on staging repeat only: one **owner-controlled recipient** end to end (needs explicit approval, §6), 429/timeout drills via the wrong-key drill, and confirm no interaction with production data (the staging project shares nothing with `wow-forever`).

## 6. Real sends (separate explicit approval each)

Sending any real e-mail from staging (A-3/A-4) uses **only an owner-controlled recipient**, only after the owner approves "first real recipient" and has turned `AZERDEX_WELCOME_ENABLED=true` themselves. This plan does not send anything. Recommended staging mode: `AZERDEX_WELCOME_MODE=template` (the intended production configuration; G-4 proved template + CID directly), with `html` as the immediate fallback.

## 7. Rollback and teardown

1. Kill switch first: `database/rollback/0015_kill_switch.sql`; `supabase secrets unset AZERDEX_WELCOME_ENABLED`; `database/ops/0015_unschedule_welcome_worker.sql`.
2. `supabase functions delete azerdex-welcome-worker --project-ref <STAGING_REF>`; unset the staging secrets; if a staging-only Resend key was used, the **owner** revokes it (this plan never touches keys).
3. Optional schema rollback: `database/rollback/0015_rollback.sql` then `database/ops/0015_record_migration_ledger.sql -v name=rollback_azerdex_welcome_outbox`.
4. Delete the project (dashboard) once acceptance evidence is recorded in `acceptance.md`. Confirm `list_projects` shows only the original projects and `wow-forever` is untouched (ledger unchanged apart from the owner's own steps).

## 8. What this plan cannot show

Anything about the production project's own Auth version (staging and production could differ: record both versions and repeat G-2's S1–S5 on production only if the owner decides to, with 0015 applied there under the two-approval rule), real-client rendering beyond Gmail desktop (G-4 covered Gmail desktop only), and Vercel/CTA readiness (B-1, separate).
