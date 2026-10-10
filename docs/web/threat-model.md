# ForeverDB Web — threat model (STRIDE-lite)

Scope: the public website, its BFF API, the public read DB, the publication worker and the new production export (0010).
Out of scope: Companion and ingest (covered by `docs/0.8-api-security-hardening.md`).

## Assets
1. **Private production data**: installation IDs and owner UIDs, Guildbook rosters, diagnostics, API budgets, auth.
2. **Companion availability**: the production API budgets (0009).
3. **Integrity of published statistics**: what players rely on.
4. **Website availability and cost**.
5. **Secrets**: worker DB credentials, web reader credential, Upstash token, salts, Turnstile secret.

## Trust boundaries
B1 browser ↔ edge/app · B2 app ↔ public DB · B3 worker ↔ production export · B4 worker ↔ public DB · B5 repo/CI ↔ deployment.

## Threats and mitigations

| # | Threat | Mitigation (where) | Residual |
| --- | --- | --- | --- |
| T1 | Website bug or SQLi leaks private data | Website never connects to production (`env.ts` refuses the prod ref). The public DB contains only allowlisted aggregates (`data-classification.md`). All SQL is fixed, parameterized function calls (`postgres-adapter.ts`) | Low: no private data exists in the public DB |
| T2 | Export accidentally widened (e.g. installation_id added) | Strict zod `.strict()` contract fails the run closed. Unit and integration tests cover tampered exports | Requires a reviewed code change to widen |
| T3 | Projection reader abuses production | Role can only EXECUTE 6 export functions. No table, `private` or `auth` access. Read-only, 2 connections, 60 s timeout. In-migration assertions (0010) | Credential theft lets an attacker read the same aggregates the site publishes anyway |
| T4 | Poisoned observations (fake counts or names from a modified client) | Name allowlist and rejection-ratio fail-closed. Invariants (drops ≤ observations, quantity ≥ drops). Anomaly ratio. Dominance flag (≥90 % from one installation ⇒ never "high"). Shrink guard (>50 % item loss needs override) | Plausible-looking fake counts from many anonymous installations remain possible. Needs registered contributors or outlier-robust aggregation later |
| T5 | Website traffic exhausts Companion budgets | Website uses a separate DB, so production budgets are never touched | None |
| T6 | Scraping / enumeration / cost DoS | Distributed per-IP, per-session and global limits. Blank global enumeration refused. Page/offset caps (≤1000 search, ≤2000 zone). 2–3 s DB timeouts. TTL cache. CDN cache for API. Turnstile soft challenge. Dedicated strict limiter for `POST /api/v1/challenge` (per-IP, per-/64 for IPv6, plus global ceiling; fail-closed; body ≤ 4 KiB counted as read; proxy buffer 8 kB). Platform WAF (to configure) | Volumetric DDoS needs the edge/WAF. Public aggregates are scrapeable by design within limits |
| T7 | XSS | React escaping. Nonce CSP with `strict-dynamic`, no `unsafe-inline`/`eval` scripts. Single audited JSON-LD sink with `<` escaped. Markdown with `skipHtml`, link/image allowlists. Name sanitization at publish | E2E: XSS payloads inert, no CSP violations |
| T8 | CSRF | No state-changing endpoints except `/api/v1/challenge`, which requires same-origin `Origin`, JSON and a Turnstile token; cross-origin posts are refused before they can consume a victim's rate budget. SameSite cookies | — |
| T9 | SSRF | The only outbound calls go to fixed hosts (Upstash URL from env, Cloudflare siteverify). No user-supplied URLs are fetched | — |
| T10 | IDOR/BOLA | No per-user resources exist. Future account features need ownership proofs (ADR-010) | Revisit with accounts |
| T11 | Cache poisoning / private data in shared cache | API: unknown params → 400, no cookies on cacheable responses, errors `no-store`. HTML: `private, no-store`. Nothing personalized is cached | — |
| T12 | Secret leakage to the client | Only `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is public. CI builds with canary secrets and scans `.next/static` for them, for DB URLs and JWTs, and fails on source maps. Errors and logs redact URLs | Operator discipline for env management |
| T13 | Publisher compromise writes garbage | Publisher can only INSERT into **staging** publications (RLS) and call begin/finalize. It cannot SELECT, UPDATE, DELETE or roll back. Finalize validation, shrink guard, audit log, operator rollback | A compromised worker could publish plausible bad data. Detect via freshness/count monitoring and roll back |
| T14 | Public DB reader credential stolen | Role is limited to bounded `web_api.*` functions over public data. 20 connections, read-only, timeouts | Low impact. Rotate |
| T15 | Supply chain | Exact pins and lockfiles. `npm audit` (high fails CI). Dependabot. CodeQL security-extended. Minimal dependencies (no gray-matter, no Supabase SDK) | Standard residual risk |
| T16 | Privacy of visitors | No analytics or third-party scripts. IPs only as keyed hashes in short-lived counters. Logs carry no raw IPs or query text. Cookies documented on `/about/privacy` | — |
| T17 | Misleading data (credibility) | "Observed drop rate" labels everywhere. Sample-size tiers, Wilson intervals, rates hidden below threshold. Coverage/provisional notes. Synthetic banner on preview | — |
| T18 | Proprietary imagery | No Blizzard art is shipped. Coordinate plots only. Original logo and SVG glyphs | — |

## Abuse cases explicitly tested
Tampered export (extra column) · flood of hostile names · drop > observations · SQL-ish and XSS payloads in queries · unknown, duplicate and oversized params · negative/zero/non-canonical IDs · web reader attempting SELECT/INSERT/UPDATE/admin calls · publisher attempting SELECT/DELETE/rollback/injecting into the active publication · per-IP 429 with a second client unaffected · global budget against IP rotation · challenge-pass tampering, expiry and IP binding · challenge POST flood → 429 with zero Siteverify calls, spoofed headers/rotating session cookie, fail-closed on Upstash failure, Content-Length missing/invalid/lying, oversize and malformed bodies, matcher coverage · zone item counts never numeric. See `verification-results.md`.

## Residual risks added with the challenge hardening (2026-10-10)
- Global challenge ceiling can be exhausted by a distributed attacker (availability of *new* passes only; outbound calls stay ≤ ~1/s).
- `x-forwarded-for` is trusted as first entry: only valid if the platform overwrites it. Prefer `x-real-ip` (Vercel) or `cf-connecting-ip`.
- Preview deployments without `RATE_LIMIT_SALT` fall back to a public dev salt (hashed IP prefixes in logs/pass cookies become guessable for IPv4). Production requires the salt.
- Shared NAT/CGNAT users share a 6-per-10-minute challenge budget.

## Deployment-environment threats (2026-10-10 hardening)

| Threat | Mitigation | Evidence | Residual |
| --- | --- | --- | --- |
| **Silent `local` fallback on a hosted deployment** (fixtures, localhost canonical, non-`Secure` cookie, in-memory limiter) — *observed live* | Explicit designation required; `local` rejected when hosted; data source explicit; https non-local `SITE_URL` | `env-matrix.test.ts`, `preview-safety.spec.ts` (3 refusal cases), live before/after in `vercel-environments.md` | Non-Vercel hosts cannot be detected: Vercel is the only supported host |
| **Synthetic demo mistaken for a production release** (or the reverse) because it is served through the Vercel production alias | ForeverDB designation is independent of Vercel's target; `X-ForeverDB-Deployment` header and `<meta>`; `production` only valid when `VERCEL_ENV=production` | unit + HTTP tests | An operator can still set `production` on a production target with all production requirements met — intended, and gated by the go-live checklist |
| **Search-engine indexing of synthetic data** | `X-Robots-Tag` on HTML, API and error responses; robots meta; `robots.txt` disallow-all; empty sitemap; SSO | HTTP tests; live headers | `robots.txt`/sitemap are served by routes the proxy matcher excludes, so they rely on their own content, not the header |
| **Deployment-protection bypass / exposure** — a project flag is not proof; `all_except_custom_domains` makes any attached custom domain public | Policy: no custom domain until go-live; `verify-deployment.mjs --expect protected` fails on any 2xx or application content | script validated against protected and leaking stand-ins | **Unauthenticated external test PENDING** (sandbox cannot reach `vercel.app`) |
| **Private-database credentials injected into the website** (Vercel marketplace/Supabase integration adds `SUPABASE_*`, `POSTGRES_URL`) | Rejected on hosted/designated deployments; value scan for the private project reference; bundle-secret scan in CI | unit tests; bundle scan | Account System V1 will need a deliberate, reviewed exception |
| **Secret exposure via errors, logs, headers, bundles** | Messages name variables only; generic 500/400; no `X-Powered-By`; canary secrets in the CI build and bundle scan | tests assert no stack/SQL/connection string, no secret in HTML | Build logs of third parties are out of scope |
| **Spoofable client IP** (`cf-connecting-ip` without Cloudflare, `x-forwarded-for` where not overwritten) | `cf-connecting-ip` rejected on Vercel; `x-real-ip` recommended and required in production | unit tests | `x-forwarded-for` remains selectable; only valid where the platform overwrites it |
| **CI checks that run but are not enforced** | Aggregate `Web release gate`; no path filter; ruleset JSON | `release-gates.md` | **Enforcement PENDING** until the ruleset is applied and a failing PR is shown blocked |
| **Runtime drift between CI and hosting** (Node 22 vs 24) | Single pinned major, CI check | CI step | Node 24 migration deferred and dated |
| **Unintended effect on the live demo when the change merges** | Explicit owner precondition (set two non-secret variables first); previous deployment restorable with Instant Rollback; refusal is fail-closed (HTTP 500), never fail-open | `release-gates.md` §3 | The connector cannot set environment variables, so this is an owner step |

Additional abuse cases tested: hosted missing designation, production + fixture, production without Upstash/trusted-IP/salt, `http` or localhost `SITE_URL` on a hosted deployment, public DB URL referencing the private project, wrong database role, `SUPABASE_*` variables, secrets echoed in error messages, preview metadata allowing indexing.
