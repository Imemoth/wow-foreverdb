# Integrated end-to-end stack (Account System V1, PR E)

A **disposable** stack used by `web/playwright.account-e2e.config.ts` and the CI check **`Account end-to-end (GoTrue + PostgREST)`**
(`.github/workflows/account-e2e-integration.yml`). Everything here is a test fixture: public test constants only, no Supabase project, no real
credential, never production. If a component cannot start, the suite **fails** (integrated acceptance BLOCKED); it never falls back to a stub.

| Component | What it is | Pin |
| --- | --- | --- |
| PostgreSQL | 16 (CI: `postgres:16` container; `track_commit_timestamp=on`) | major 16 |
| Auth | **real GoTrue**, built from source by `database/tests/account/build-gotrue.sh` | `supabase/auth` **v2.197.0**, commit `4eee58f296d9698a1c2c0ae14d7a0b379c7622d3` (the build refuses a moved tag) |
| REST | **real PostgREST** (static release binary) | **v12.2.12**, archive sha256 `5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5` |
| Mail | Mailpit (captures every message GoTrue sends over SMTP) | v1.31.5 |
| Gateway | `web/tests/auth-stack/stack-server.mjs`: stands in for Kong: `/auth/v1/*` -> GoTrue, `/rest/v1/*` -> PostgREST (prefix stripped, `apikey` must equal the stack's anon key, no other behaviour) | — |
| Fault injector | `chaos-proxy.mjs`: forwards untouched unless a test switches a mode (lost redemption reply, failing logout). Only `web/tests/account-e2e/05-resilience.spec.ts` uses it | — |
| Database | repository migrations **0001-0009, 0011 and 0012**, applied by `database/tests/account/stack.sh` as a non-superuser migration role (stand-in for Supabase `postgres`); `0010` and `0013` are **not** applied | — |

PostgREST settings (recorded in `.stack/versions.json` at start-up): `db-schemas = public`, `db-anon-role = anon`, HS256 JWT secret shared with GoTrue,
`db-max-rows = 1000`, **`db-tx-end = commit`**. A second instance with `commit-allow-override` exists ONLY so that one test can show why the reviewed value matters
(with the override, `Prefer: tx=rollback` rolls the abuse counters back). Auth settings: confirm e-mail ON, anonymous sign-in ON, refresh-token rotation ON (reuse
interval 10 s), CAPTCHA / single-session-per-user / session time-box / inactivity timeout OFF, access-token lifetime 3600 s.

`up.sh` starts PostgREST **before** migration 0012, then applies 0012 and waits until the migration's `notify pgrst, 'reload schema'` makes the functions appear
(status 404 `PGRST202` -> 401 for the anon role). The observation is written to `.stack/schema-cache.json` and asserted by the suite.

## Run locally

```bash
# a throw-away PostgreSQL 16 superuser connection (NEVER a real database), Go, Node 24, `npm ci` in web/
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=...
database/tests/account/build-gotrue.sh /path/to/gotrue                      # real GoTrue at the pinned commit
# PostgREST: download the pinned release, verify its sha256, extract `postgrest`;  Mailpit: GOBIN=... go install github.com/axllent/mailpit@v1.31.5
export GOTRUE_BIN=/path/to/gotrue POSTGREST_BIN=/path/to/postgrest MAILPIT_BIN=/path/to/mailpit
web/tests/e2e-stack/up.sh                     # refuses to start if one of its ports is taken by a leftover process
cd web && FOREVERDB_DEPLOYMENT=local ACCOUNT_AUTH_MODE=local ACCOUNT_CSRF_SECRET=... \
  ACCOUNT_AUTH_URL=http://127.0.0.1:54321 ACCOUNT_AUTH_PUBLISHABLE_KEY=$(. tests/e2e-stack/.stack/env; echo $ACCOUNT_STACK_ANON_KEY) npm run build
npx playwright test -c playwright.account-e2e.config.ts      # starts three `next start` instances itself (3210 main, 3211 chaos, 3212 dead limiter)
web/tests/e2e-stack/down.sh
```

Ports used: 9999 (GoTrue), 54321 (gateway), 54323/54327 (PostgREST + admin), 54324/54325/54326 (Mailpit HTTP/SMTP, templates), 54328/54329 (override instance), 54330 (chaos proxy),
3210-3212 (website). The SQL suite (`database/tests/account`) uses the same database name and GoTrue port: do not run both at the same time.

## What this stack proves, and what it does not

Proves: website <-> real GoTrue <-> real PostgREST <-> migration 0012 interoperate (JWT validation, session-claim propagation, EXECUTE privileges, commit semantics,
PT401/PT403/PT429/PT400 propagation, schema-cache reload, response shapes the website's Zod contracts expect). Does **not** prove: the hosted Supabase gateway (Kong, new-style
`sb_publishable_` keys), the hosted GoTrue/PostgREST versions and settings, connection pooling and statement timeouts of a hosted database, real SMTP delivery, or anything about
Windows. Those are the owner's staging checks: [../../../docs/account-v1/staging-runbook.md](../../../docs/account-v1/staging-runbook.md).
