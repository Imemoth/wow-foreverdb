# Website BFF API, rate limits and caching

All endpoints are `GET` unless noted. Methods not listed return 405. Unknown or duplicate query parameters return **400**. Errors are `{ "error": "<code>" }` with `Cache-Control: no-store` and contain no stack traces or SQL. Success bodies are wrapped as `{ dataset, publicationId, publishedAt, data }`, where `dataset` is `synthetic-sample` or `published`.

| Endpoint | Params / bounds | Notes |
| --- | --- | --- |
| `/api/v1/search` | `q` 0/2–80 chars (no `% _ \` or control chars), `category` ∈ item/creature/object/fishing_pool/fishing, `zone` 1–999999, `kind` ∈ loot kinds, `sort` ∈ relevance/name/observations, `page` ≥1, `limit` 1–50; offset ≤ 1000 | Blank `q` requires `zone` or `kind` (no global enumeration) |
| `/api/v1/item/{id}` | id: canonical decimal 1–999,999,999 | 404 if not published |
| `/api/v1/source/{type}/{id}` | type ∈ creature/gameobject/fishing/item; negative id only for gameobject | All level variants, buckets, drops (≤300), locations (≤2000) |
| `/api/v1/zone/{mapId}` | `q`, `type`, `kind`, `page` (≤41, 50/page) | Zone summary plus bounded directory |
| `/api/v1/tooltip/item/{id}`, `/api/v1/tooltip/source/{type}/{id}` | — | Compact text-only tooltip |
| `/api/v1/meta` | — | Publication id/time, counts, thresholds |
| `POST /api/v1/challenge` | JSON `{token}` ≤ 4 KiB, same-origin `Origin` | 404 unless Turnstile configured. Sets `fdb_pass` (HttpOnly, SameSite=Strict, 30 min, IP-bound HMAC) |

Every DB call maps 1:1 to a `web_api.*` function. The functions re-validate the same bounds server-side (defence in depth) and run with 2 s function / 3 s role statement timeouts.

## Caching

| Response | Cache-Control |
| --- | --- |
| API 200 | `public, max-age=60, s-maxage=300, stale-while-revalidate=600` (no `Set-Cookie`) |
| API 4xx/5xx, 429 | `no-store` |
| HTML pages | `private, no-cache, no-store` (nonce CSP; see ADR-005) |
| RSS | `public, max-age=300, s-maxage=900` |
| In-process adapter cache | TTL 60 s, ≤2,000 keys, failures not cached |

## Rate limits (defaults, `src/lib/security/rate-limit.ts`; override with `RATE_LIMITS_JSON`)

| Rule | Routes | Per IP / min | Per session / min | Global / min | Soft challenge at |
| --- | --- | ---: | ---: | ---: | ---: |
| `api_search` | `/api/v1/search` | 30 | 30 | 3,000 | 20 (if Turnstile configured) |
| `api_detail` | other `/api/v1/*` (incl. tooltips) | 120 | 120 | 10,000 | — |
| `page_db` | `/database`, `/item/*`, `/creature/*`, `/object/*`, `/fishing/*`, `/zone/*` | 90 | 90 | 15,000 | 60 |

Exceeding any counter returns **429** with `Retry-After` (seconds to the window end). API calls get JSON. HTML gets a minimal static page.

### Capacity assumptions (documented, not measured)
- The public DB is tiny today (<2k rows per table). A bounded `web_api.search` with trigram index and LIMIT ≤ 50 should take a few ms. Assume ≤ 20 ms p95 at 10× current data. At that cost, 3,000 searches/min ≈ 50 qps ≈ 1 DB core-second per second of headroom. That fits a small dedicated instance; **verify with a staging load test before go-live**.
- Upstash: each limited request costs 1 pipeline call with 2–3 INCR+EXPIRE pairs. At the global ceilings (~28k req/min) that is ~40M commands/month at sustained peak. Check against the chosen Upstash plan and set a budget alert.
- Per-IP 90 page views/min is well above human browsing (≤ 10/min) and still throttles naive crawlers. Good crawlers mostly fetch the sitemap URLs.
- Shared NAT (e.g. a guild on one IP) could hit per-IP limits. The Turnstile pass raises nothing beyond `perIp`, but removes the soft challenge. Tune `perIp` with production telemetry.

### Store failure policy
Upstash unreachable or erroring: `/api/*` → **503 fail-closed**; HTML pages → fail-open with a log event `rate_limit_store_error` (still protected by edge/WAF, DB timeouts and the in-process cache). Alert on that event.

## Not reused from the Companion
None of the 0009 quotas, RPCs, keys or JWTs are used by the website, and website traffic cannot consume Companion capacity.
