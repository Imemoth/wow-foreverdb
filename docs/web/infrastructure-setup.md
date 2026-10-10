# Manual infrastructure setup (NOT done — requires owner approval)

Nothing below has been provisioned or configured. Each step names the secret it produces and **who may hold it**.

| # | Step | Produces | Held by |
| --- | --- | --- | --- |
| 1 | Create a **new, separate** Supabase project (or managed Postgres) for the public read model, e.g. `foreverdb-public`, EU region. **Disable the Data API** (Settings → API) | Owner/admin credentials | Owner only (password manager) |
| 2 | Apply `database/public-read/migrations/0001_public_read_model.sql` as the project owner. Run `database/public-read/tests/public_read_model_security.sql` after the first publication | — | — |
| 3 | `alter role foreverdb_web_reader login password '<random 32+>';` | `PUBLIC_READ_DATABASE_URL` (pooler, port 6543, `sslmode=require`) | **Website runtime only** |
| 4 | `alter role foreverdb_publisher login password '<random 32+>';` | `PUBLIC_PUBLISHER_DATABASE_URL` | **Worker only** |
| 5 | **Production approval gate.** Apply `database/private-export/0010_public_projection_export.sql` to production in a low-traffic window, then `alter role foreverdb_projection_reader login password '<random>';` | `PRIVATE_EXPORT_DATABASE_URL` | **Worker only** |
| 6 | Create a protected GitHub environment `publication` with required reviewers. Add the two worker URLs as environment secrets. Add a scheduled workflow (hourly) running `publisher` `publish` | — | — |
| 7 | Create an Upstash Redis database (EU) for rate limiting. Set a monthly budget alert | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Website runtime only |
| 8 | Generate `RATE_LIMIT_SALT` and `CHALLENGE_COOKIE_SECRET` (32+ random bytes each) | — | Website runtime only |
| 9 | Optional: Cloudflare Turnstile site | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET_KEY` | Runtime |
| 10 | Vercel project (exists: `wow-foreverdb`, root directory `web/`, Hobby). **Do not** set production values yet. Current temporary demo and previews: `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture` (Production **and** Preview targets), recommended `TRUSTED_IP_HEADER=x-real-ip`; Deployment Protection ON. Full matrix, owner steps, Node decision and promotion control: **`docs/web/vercel-environments.md`**. Future production only: `FOREVERDB_DEPLOYMENT=production`, `FOREVERDB_DATA_SOURCE=postgres`, `SITE_URL=https://<domain>` (must equal the Vercel production domain), `TRUSTED_IP_HEADER=x-real-ip`, plus the secrets above | — | — |
| 11 | Vercel Firewall / WAF: enable bot protection, add a rate-limit rule for `/api/v1/*` and `/database` (e.g. 300 req/min/IP, challenge then deny), and enable Attack Challenge Mode under attack. Spend management/budget alerts | — | — |
| 12 | Domain + HTTPS. HSTS is sent automatically for https `SITE_URL`. Consider HSTS preload only after the domain is final | — | — |
| 13 | Monitoring: uptime/freshness probe on `/api/v1/meta` (`publishedAt` < 3 h). Log drain alerts on `rate_limited` spikes, `rate_limit_store_error`, `api_error`, `publication_failed_closed` | — | — |

## Credential boundaries (must stay true)
- The website runtime never receives: production Supabase URL or keys, `service_role`, publisher or projection-reader credentials.
- The worker never receives: website secrets.
- Nobody uses `service_role` or the owner password for routine reads.
- `env.ts` enforces the web side at startup: explicit designation on hosted deployments (never `local`), forbidden production ref and `SUPABASE*`/`DATABASE_URL`-style variables, `foreverdb_web_reader` role only, fixture refused and upstash/salt/https/trusted IP required in production.

## Recommended production hygiene (separate approvals)
- Enable RLS on `private.foreverdb_api_budgets` (advisor finding, see assessment §1).
- F-3 migration (done): `0011_fix_observed_drop_rate_denominator.sql` (denominator fix in `private.foreverdb_item_stats` / `foreverdb_source_stats`). **Applied to production 2026-10-10 (ledger `20261010151518`); SQL verified and Companion Search acceptance 5/5 PASS — F3_FULLY_VERIFIED**; see `docs/f3-observed-rate-denominator.md`.
- Supabase Auth anonymous sign-in rate limits and CAPTCHA (existing roadmap item).

## Vercel — current state and owner actions (2026-10-10)
- Project `wow-foreverdb` exists (Next.js, Hobby, GitHub-linked, root `web`), production-target deployment READY, **Vercel Authentication on** (`all_except_custom_domains`), no password/trusted-IP protection, **no custom firewall configuration**, no custom domain.
- The connector used for the hardening work could **not** read or write environment variables (HTTP 403, scoped and unscoped), so the variable matrix is an **owner action** (`vercel-environments.md` §3). It must be done before merging the hardening PR.
- Pending owner decisions: change the Production Branch to a `release` branch (promotion control), dashboard Node.js version is already 24.x (matches `engines`), the ruleset import (`release-gates.md`), and the unauthenticated external access test.
- Not to be done without separate approval: custom domains/DNS, billing or plan changes, enabling `FOREVERDB_DEPLOYMENT=production`.
