# Ephemeral Auth stack for the account acceptance suite

Used by `web/playwright.account.config.ts` and the CI job `Account web auth (real GoTrue)`
(`.github/workflows/account-web-auth.yml`). Everything here is a **disposable test fixture**: public test constants only, no
Supabase project, no real credential, never production.

| Part | What it is |
| --- | --- |
| Auth | **real GoTrue** built from a pinned `supabase/auth` tag (`v2.197.0` in CI) |
| Database | **real PostgreSQL** (CI service container; locally any throw-away cluster) |
| Mail | **Mailpit** captures every message GoTrue sends over SMTP; tests read it over its HTTP API |
| `stack-server.mjs` | a 60-line stand-in for the Supabase API gateway (Kong): maps `/auth/v1/*` to GoTrue (prefix stripped, `apikey` required) and serves the two e-mail templates. It adds no behaviour of its own. |

Why not `supabase start`? The Supabase CLI needs Docker and several images (Kong, PostgREST, Studio, ...). The website talks to
GoTrue only, so the stack is reduced to what PR B exercises. PostgREST and the account RPCs arrive with PR C; its CI will add them.

## Settings the stack runs with (match the product requirement, `docs/account-v1/security.md` section 3.2)

* confirm e-mail **on**; anonymous sign-ins **on** (the Companion needs them); refresh-token rotation **on**, reuse interval 10 s
* access-token lifetime **25 s** (so refresh paths are exercised in seconds); the website refreshes at 15 s remaining
* CAPTCHA, single-session-per-user, session time-box and inactivity timeout are **off** (not assumed anywhere)
* e-mail templates link to `{{ .SiteURL }}/account/auth/confirm?token_hash=...&type=email|recovery` (explicit-POST confirmation)
* redirect allow list = the exact callback URLs of the test servers, nothing else

## Run locally

```bash
# 1. a throw-away PostgreSQL superuser connection, a GoTrue binary + the supabase/auth checkout (for migrations/), and mailpit
export PGHOST=127.0.0.1 PGPORT=54322 PGUSER=postgres            # (+ PGPASSWORD if needed)
export GOTRUE_BIN=/path/to/gotrue MAILPIT_BIN=/path/to/mailpit GOTRUE_DIR=/path/to/supabase-auth-checkout
./tests/auth-stack/up.sh            # writes tests/auth-stack/.stack/env (anon key, URLs)
# 2. production build, then the suite (it starts six `next start` instances itself)
npm run build && npx playwright test -c playwright.account.config.ts
./tests/auth-stack/down.sh
```

If the stack cannot start the suite **fails**; it never substitutes mocks.
