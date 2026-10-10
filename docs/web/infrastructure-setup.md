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
| 10 | Vercel project with root directory `web/`. Production env: `FOREVERDB_DEPLOYMENT=production`, `FOREVERDB_DATA_SOURCE=postgres`, `TRUSTED_IP_HEADER=x-real-ip`, `SITE_URL=https://<domain>`, plus the secrets above. Preview env: `FOREVERDB_DEPLOYMENT=preview`, fixture data, Vercel Deployment Protection ON | — | — |
| 11 | Vercel Firewall / WAF: enable bot protection, add a rate-limit rule for `/api/v1/*` and `/database` (e.g. 300 req/min/IP, challenge then deny), and enable Attack Challenge Mode under attack. Spend management/budget alerts | — | — |
| 12 | Domain + HTTPS. HSTS is sent automatically for https `SITE_URL`. Consider HSTS preload only after the domain is final | — | — |
| 13 | Monitoring: uptime/freshness probe on `/api/v1/meta` (`publishedAt` < 3 h). Log drain alerts on `rate_limited` spikes, `rate_limit_store_error`, `api_error`, `publication_failed_closed` | — | — |

## Credential boundaries (must stay true)
- The website runtime never receives: production Supabase URL or keys, `service_role`, publisher or projection-reader credentials.
- The worker never receives: website secrets.
- Nobody uses `service_role` or the owner password for routine reads.
- `env.ts` enforces the web side at startup: forbidden production ref, `foreverdb_web_reader` role only, upstash/salt/https/trusted IP required in production.

## Recommended production hygiene (separate approvals)
- Enable RLS on `private.foreverdb_api_budgets` (advisor finding, see assessment §1).
- F-3 migration (done): `0011_fix_observed_drop_rate_denominator.sql` (denominator fix in `private.foreverdb_item_stats` / `foreverdb_source_stats`). **Applied to production 2026-10-10 (ledger `20261010151518`, SQL verified); Companion acceptance pending**; see `docs/f3-observed-rate-denominator.md`.
- Supabase Auth anonymous sign-in rate limits and CAPTCHA (existing roadmap item).
