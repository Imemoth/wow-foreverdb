# Account System V1 — acceptance and owner actions

## 1. Evidence ledger rules

Each capability carries exactly one state; it only moves forward when the named evidence exists.

| State | Meaning | Required evidence |
| --- | --- | --- |
| IMPLEMENTED | code merged-ready in a PR | diff, unit tests locally |
| CI VERIFIED | GitHub Actions green on the PR's final head | run URL, check list |
| STAGING VERIFIED | executed against the isolated real Supabase Auth + Postgres (CI stack or the owner's staging project) | test log / run URL; for staging, the owner's confirmation |
| WINDOWS VERIFIED | executed on a real Windows Companion build | owner's acceptance table (same style as the F-3 runtime acceptance) |
| PRODUCTION APPROVED | owner approved activation | written approval; approved dry-run and rollback plan |
| BLOCKED / PENDING | not done | what is missing |

Passing mocks never advances a capability beyond IMPLEMENTED.

## 2. Per-PR acceptance gates

| PR | Gate to call it review-ready |
| --- | --- |
| A | account config/contract/static-boundary tests pass; full web suite passes on Node 24; mutation checks demonstrated; independent architecture and security review recorded; CI green on the final head |
| B | PR A gates + Playwright against real GoTrue with captured mail: sign-up, verify, login, logout, recovery, CSRF, redirect, enumeration, no-store, bundle scan; **no** installation or Guildbook access |
| C | forward-only `0012` + rollback; SQL suite (negative matrix, concurrency with parallel sessions, row-hash preservation, ACL assertions, `prosrc` hash of existing functions); runs in CI against ephemeral PostgreSQL and against real GoTrue; recovery runbook rehearsed |
| D | `dotnet test` regression suite on Windows CI (concurrent start, refresh rotation, failed refresh, sign-out, session switching, sync after claim, restart persistence, corrupt session file); new alpha build `0.9.0-alpha` per `docs/VERSIONING.md` (csproj, installer, CHANGELOG, ROADMAP) |
| E | cross-component run (including the Companion's anonymous sign-in and refresh under the staging Auth settings): web registration → email → Companion login; anonymous installation → claim → ownership; repeated sync with preserved history; two accounts + one anonymous identity denied everywhere; restart/expiry/logout/race/replay; evidence from CI and the owner's Windows machine |

Final Account System V1 acceptance requires real Windows and web evidence including two-account isolation and preserved historical data. No PR is merged automatically.

## 3. Owner action checklist

Nothing below was done by this work. Items marked **approval** change real settings, create resources or touch billing and need an explicit owner decision.

| # | Action | When | Approval |
| --- | --- | --- | --- |
| 1 | Review and merge PR A (specification + foundation) | now | review |
| 2 | Create an **isolated staging Supabase project** (never the production `wow-forever` project) and provide only its URL and publishable key to the Vercel *Preview* environment as `ACCOUNT_AUTH_MODE=staging`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_PROJECT_REF`, `ACCOUNT_AUTH_PUBLISHABLE_KEY` and a random `ACCOUNT_CSRF_SECRET` of at least 32 characters (never to Production) | before PR E staging acceptance | **approval** (new resource, possible cost) |
| 3 | Staging Auth settings: confirm email **on**, custom SMTP with SPF/DKIM/DMARC, email templates using `token_hash` links to `/account/auth/confirm`, redirect URLs limited to the preview host pattern, leaked-password protection on, **Supabase CAPTCHA off** (it is project-wide and the Companion cannot satisfy it; the website uses its own Turnstile check, keys need approval), single-session-per-user / session time-box / inactivity timeout **off**, review Auth rate limits and anonymous sign-in limits, refresh-token rotation on | before PR B staging run | **approval** |
| 4 | Provide a Windows machine session for Companion acceptance (PR D/E) | PR D/E | — |
| 5 | Keep Vercel Authentication on the demonstration; keep Production Branch = `release`; do not merge account PRs into `release` | always | — |
| 5a | Define and record **direct Auth abuse controls** before any production plan: reviewed Auth rate limits, scheduled sign-up/anonymous-creation monitoring with alert thresholds and a named responder, SMTP quotas and a daily cap, incident runbook (threat A24) | before production | **approval** |
| 6 | Before any production consideration: review the migration dry-run, rollback and recovery runbook; production leaked-password protection, SMTP, rate limits and CAPTCHA; decide quotas/tiering separately | later milestone | **approval** |
| 7 | Flipping `PRODUCTION_ACCOUNT_AUTH_APPROVED` and setting `FOREVERDB_DEPLOYMENT=production` | **not in V1** | **approval** + reviewed code change |

## 4. Explicit non-actions (verified, current)

No account migration exists or was applied; migration `0010` is not applied; the production ledger ends at `0011`; no Supabase setting, email provider, credential, billing or Vercel configuration was changed; `release`, the Vercel Production Branch and Vercel Authentication are untouched; no service-role credential exists in the website; production activation is blocked by code.
