# Manual infrastructure setup (mostly NOT done — requires owner approval)

Most of the steps below are reserved for a future, separately approved real-data Production release. The public `beta.azerdex.com` track already has Vercel Preview wiring **and a branch-scoped Upstash rate-limiter configuration** — see the 2026-10-20 addendum at the end of this document. Each step names the secret it produces and **who may hold it**.

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

## Addendum (2026-10-20): what's actually live for the public beta vs. what step 1–9/11–13 still reserve for a future real-data Production

This section exists because the title above, read literally, overstated things once step 10's own description had quietly become true. It does not change the step table; it clarifies which rows are done and which remain genuinely open.

**Already configured for the `beta.azerdex.com` public-beta track (step 10 and beta-specific parts of steps 7–8):**
- The existing Vercel project `wow-foreverdb`, with `beta.azerdex.com` attached as a branch-pinned custom domain tracking `web/azerdex-beta`, and an explicit, scoped Vercel Deployment Protection Exception for that one domain (every other Preview deployment stays behind Vercel Authentication) — see `vercel-environments.md` §10.
- `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture` on that domain: a synthetic-fixture deployment, never real observations, with the site's own "Preview with synthetic sample data" banner and the narrow homepage-only indexing exception (same §10).
- **Rate-limiter configuration (read-only Vercel verification, 2026-10-20):** the `web/azerdex-beta`-scoped Preview variable is `RATE_LIMIT_BACKEND=upstash`, and the connected Upstash Marketplace REST API variables and `RATE_LIMIT_SALT` are present in Preview scope. `web/src/lib/env.ts` accepts the Marketplace REST aliases and fails closed if an Upstash backend lacks a REST URL/token. This establishes the **configured** distributed limiter, not independent proof that a particular live request used Redis; that operational check remains separate. Upstash provisioning for the beta is not a pending task.

**Still open for future, separately approved real-data Production (steps 1–6, production-specific parts of 7–8, 9, 11–13):**
- Steps 1–6: the separate public-read PostgreSQL project, its migrations, reader/publisher roles, the production-export approval gate, and the scheduled publication workflow. The public beta's fixture data does not touch any of this.
- Step 7 (Production-specific): review capacity, quotas, budget alerts and separation/credentials for the real-data Production workload. The beta already has an Upstash Marketplace connection; that is **not** approval of Production readiness.
- Step 8 (Production-specific): review separate `RATE_LIMIT_SALT` and any required `CHALLENGE_COOKIE_SECRET` for the future Production flow. `RATE_LIMIT_SALT` is already present for beta Preview; this does not satisfy Production's own security gate.
- Step 9: Cloudflare Turnstile.
- Step 11: Vercel Firewall/WAF rules and Attack Challenge Mode — **not configured** (confirmed in `vercel-environments.md` §5: the active-firewall-config API returns 404). The public beta relies only on the application-level limiter and Vercel's platform DDoS mitigation, exactly as a synthetic low-traffic demo is expected to.
- Step 12: a domain beyond the existing Vercel-managed `beta.azerdex.com`/`azerdex.com`, and any HSTS-preload decision.
- Step 13: uptime/freshness monitoring, log-drain alerting and a rehearsed rollback procedure — all still unbuilt; nothing here is needed for a synthetic fixture deployment, but all of it is a precondition the go-live checklist (`go-live-checklist.md` §C) already lists for the real-data Production gate.

No infrastructure change accompanies this addendum. It is a wording correction only, matching `docs/web/markdown-audit-2026-10-20.md`'s discrepancy #4.
