# Verification results — `web/foundation-mvp`

Executed in an isolated cloud workspace (Node 22.22, PostgreSQL 16.15 ephemeral clusters, Chromium via Playwright 1.56.1). **No check ran against production except the read-only audit queries listed in the assessment.**

**Evidence tiers used below:** *Implemented* (code exists) · *Locally tested* (run in the authoring workspace) · *GitHub CI verified* · *Runtime verified* (real Upstash/Turnstile/staging) · *Pending infrastructure* · *Pending production approval*.

**GitHub CI status (GitHub CI verified, 2026-10-10).** Head `3e463f3` (hardening commit `d16f7d5` + a one-line CodeQL test fix) is green on PR #22:
- `ForeverDB Web & publication pipeline` [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488): `web` success, `publisher-and-pipeline` success (incl. the fixture<->PostgreSQL parity step), `codeql` success; code-scanning check `CodeQL` success.
- `Collector smoke tests` [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480): success (this is where the Lua smoke tests run).
- `ForeverDB API security regressions` [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423): `pg-roles-quotas` success.
- On the intermediate head `d16f7d5` the code-scanning check failed with 1 high alert (`js/incomplete-url-substring-sanitization`, `web/tests/unit/challenge.test.ts:45`: `startsWith()` on a mocked Upstash URL, a false positive in a test mock). Fixed in `3e463f3` by comparing the parsed origin; the alert closed and the review thread resolved.
- Companion health is not a PR-triggered workflow and did not run. `Supabase Preview` was skipped.
- Earlier head `fde9ae6`: all checks green ([run 38044909365](https://github.com/Imemoth/wow-foreverdb/actions/runs/38044909365)).

CI covers only the in-repo checks above (fixture data, memory rate-limit store, mocked Upstash/Turnstile). It is **not** runtime evidence.

## 2026-10-10 Vercel preview hardening (PR `web/vercel-preview-hardening`)

Target outcome: **PREVIEW HARDENED / PRODUCTION STILL BLOCKED.** Evidence tiers as above. GitHub CI results for the final head are added below once the checks have finished; nothing here is a production or deployment-protection verification unless it says so.

### Local results (Node 22.22.0, Next 16.4.0, React 19.3.0, Playwright 1.63.0, PostgreSQL 16.15 ephemeral)

| Area | Result |
| --- | --- |
| ESLint, TypeScript (`web`, `publisher`) | **PASS** (0 errors, 0 warnings) |
| Web unit tests | **PASS 150/150** (was 115): 41 are the env/matrix suites (`env.test.ts` 6 + `env-matrix.test.ts` 35 incl. review-hardening cases) |
| Environment-boundary matrix | **PASS 41/41**: local / hosted preview / production-target demo / production, hosted without designation, production + fixture, missing Upstash/trusted IP/salt, private-project reference (case-insensitive, percent-encoded), wrong role, local-address spellings, `SUPABASE*` variables, secrets never echoed, noindex headers, `robots.txt`, sitemap |
| Mutation checks (rule deleted ⇒ test fails) | **PASS** for 4 unit rules (empty-metadata fall-through, case-insensitive marker, system-metadata exclusion, trusted-IP default) and 3 HTTP refusal rules (production + fixture, missing designation, forbidden variable names): exactly the matching case fails |
| Production build with canary secrets, bundle-secret scan | **PASS** (37 files) |
| Production dependency audit (`web`, `publisher`) | **PASS** 0 vulnerabilities |
| Web E2E (Playwright), all projects in one run | **PASS 62/62** (was 46): journeys 12 · security 6 · **preview-safety 16** · a11y/SEO (axe WCAG 2.2 AA) 16 · responsive 12 |
| Preview-safety (HTTP level) | **PASS 16/16**: synthetic banner, `X-Robots-Tag`/meta/`robots.txt`/empty sitemap, canonical on the site origin (never localhost), CSP/HSTS/nosniff/frame/COOP/Permissions-Policy, `Secure` + `__Host-` + HttpOnly + SameSite cookie, API cache and no cookie, generic errors, no secret/connection string in HTML, 429 with markers, positive control, 4 fail-closed refusals each logging exactly one rule |
| Publisher unit tests | **PASS 29/29** |
| Publication pipeline integration (ephemeral PostgreSQL) | **PASS** (all pipeline checks) |
| Website vs published read model (Postgres adapter E2E) | **PASS 18/18** |
| Fixture ↔ PostgreSQL parity | **PASS 37/37** |
| `scripts/verify-deployment.mjs` | `--expect preview` against a local preview server **22/22**; `--expect protected` **28/28** on a 401-everywhere stand-in and **0/28 (fails, as it must)** on a stand-in that leaks |
| Node/engines consistency (the CI step's logic) | **PASS** (22 / 22.x / 22.x) |
| Workflow YAML and ruleset JSON | parse OK; job names match the ruleset contexts |
| `git diff --check` | **PASS** |

Playwright note: this sandbox's pre-installed Chromium is older than Playwright 1.63 expects, so the browser tests were run with `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` (the config's existing override). CI installs the matching browser.

### Independent review

A separate reviewer agent (files and dimensions only) found **no critical or high** issues. Medium: the three "refuse to serve" HTTP tests could pass for the wrong reason (several violations each, no positive control) and the unauthenticated-reachability claim was unverified. Low: Zod enum errors echoed the received value; the private-project check was case-sensitive and not percent-decoded; `localhost.`/`0x7f.1`/IPv4-mapped IPv6 passed the local-address check for non-special URL schemes; empty-string Vercel metadata did not fall through; one rate-limit bucket if the trusted-IP header were `none`; over-stated header-coverage, Node and protection claims in the docs. **All were fixed or corrected** (tests reworked to one violation each plus a positive control and a log-reason assertion, then mutation-checked; normalisation and value-free messages in `env.ts`; documentation corrected). Left as documented limits: the proxy matcher excludes static assets, `robots.txt` and `sitemap.xml`; a refused configuration answers a bare 500; the derived `SITE_URL` may differ from the URL a visitor used (affects only the unconfigured challenge POST).

### Live observations (read-only, 2026-10-10 ~19:07 UTC, before this change)

Authenticated fetch through the Vercel connector of the live demo: HTTP 200, nonce CSP with `strict-dynamic`, HSTS, `nosniff`, `X-Frame-Options: DENY`, `Cache-Control: private, no-cache, no-store`, `X-Robots-Tag: noindex, nofollow`, synthetic banner; **defects:** canonical `http://localhost:3000` and an `fdb_sid` cookie without `Secure` (the hosted deployment silently ran as `local`). These are what the explicit designation and the origin-keyed cookie fix. The Vercel environment-variable listing and creation both returned HTTP 403, so environment variables could not be read or set from this work.

### Vercel evidence (real platform, 2026-10-10)

| Check | Result |
| --- | --- |
| Build log of the branch preview | **PASS** `engines: 22.x` overrides the project's `24.x`: *"Node.js Version \"22.x\" will be used instead"*; the `>=22` auto-upgrade warning is gone |
| New code on a Vercel preview with no ForeverDB variables | **PASS (fails closed)** HTTP 500, generic body, no application header or cookie |
| Both branch previews built | READY (`dpl_4kq9vM59…` for `240c8f8`, `dpl_2ojaHek5…` for `5d0086f`) |

### NOT RUN / PENDING (not claimed as passed)

| Item | Why | What proves it |
| --- | --- | --- |
| Unauthenticated external access to the production alias, a branch preview, `/api/v1/meta` and the search API | The connector sandbox cannot resolve or tunnel to `*.vercel.app` (DNS failure, HTTP 403 from the egress policy); the connector's own fetch uses a protection bypass, so it proves nothing about protection | `node web/scripts/verify-deployment.mjs <url> --expect protected` from an ordinary machine |
| Vercel environment variables (read and set) | HTTP 403, scoped and unscoped | Owner steps in `vercel-environments.md` §3 (**required before merging**) |
| Required status checks actually blocking a merge | No ruleset/branch-protection API available; a passing workflow is not enforcement | Import `.github/rulesets/main-release-gates.json`, show a failing PR is unmergeable |
| Vercel Production Branch / `release` branch, Node dashboard setting | Production-impacting or dashboard-only; prepared, awaiting owner approval | `vercel-environments.md` §4, §6 |
| Behaviour on Node 24 | Deliberately not changed; Node 22 pinned | A separate migration PR |
| Real Upstash, real Turnstile, WAF rules, load test | Not provisioned (unchanged) | Go-live checklist C |

## 2026-10-10 hardening (PR #22 follow-up): P1 challenge endpoint, P2 zone statistics

Results below were **locally tested**; the same suites subsequently passed in GitHub CI (see above).

| Area | Check | Result |
| --- | --- | --- |
| P1 unit (web) | `tests/unit/challenge.test.ts`: full proxy→route chain with mocked Siteverify/Upstash. Repeated POST → 429 (`Retry-After`, `no-store`) and **zero** Siteverify calls after the limit; per-IP then global ceiling; abusive IP does not burn the global budget; spoofed untrusted headers/rotating session cookie/missing trusted header cannot bypass; IPv6 /64 keying; missing/invalid/understated/overstated `Content-Length`; oversize, streamed-oversize (cancelled), at-cap/over-cap by one byte, malformed JSON/UTF-8/empty; foreign/missing origin and wrong content type refused before counting; invalid token, Siteverify outage/non-JSON, no secret/third-party body echo; Upstash HTTP 500/network/garbage → 503 fail-closed with no Siteverify call; healthy Upstash keys (no session key); unconfigured Turnstile → free 404; proxy matcher covers the route. The pre-fix proxy fails 10 of these (mutation check) | **PASS** (included in 115/115) |
| P2 unit (publisher) | `test/zone-semantics.test.ts`: item in both zones, observations `null`/`inferred`, no zone claims global 50, distinct-source counts, source observations kept, aggregates, search index global, determinism, committed web projection equals worker output | **PASS 9/9** (publisher total **29/29**) |
| P2 unit (web) | `tests/unit/zone-semantics.test.ts`: adapter, API route, rendered table labels ("Not measured", "inferred via N sources"), search ordering stays global, shared sample dataset has no numeric item zone count, creature/gathering/fishing intact | **PASS 11/11** |
| Web unit total | all files | **PASS 115/115** |
| SQL | `public_read_zone_semantics.sql` (2 PASS): web_api rows/ordering/item+source JSON; schema CHECK rejects numeric item count and mislabelled association. Existing `public_read_model_security.sql` (3 PASS), export smoke (2 PASS) | **PASS** |
| Pipeline | `scripts/public-pipeline-integration.sh` incl. new zone-semantics database: publish, idempotent republish, fail-closed cases, rollback | **PASS** (exit 0) |
| Parity | `npm run test:parity`: FixtureAdapter vs PostgresAdapter on the regression dataset (zones, zone directory incl. filters/paging/out-of-range, items, sources, search incl. zone/sort/kind) | **PASS 37/37** (found and fixed one pre-existing out-of-range total mismatch) |
| E2E fixture | incl. 2 new specs (zone directory never shows item counts; item page "Inferred") | **PASS 46/46** |
| E2E Postgres adapter | journeys + security, desktop | **PASS 18/18** |
| Static | ESLint, `tsc --noEmit` (web, publisher) | **PASS** |
| Build / bundle | `next build`; bundle secret scan (37 files) | **PASS** |
| Dependencies | `npm audit --omit=dev --audit-level=high` web and publisher | **PASS** 0 vulnerabilities |
| Repo-wide | `git diff --check` | **PASS** |
| Repo-wide | API security regression (`api_security_roles_and_quotas.sql` + anon/private check) on ephemeral PG | **PASS** locally (not touched by this change) |
| Repo-wide | Collector smoke (Lua) | **NOT RUN** locally (`lua5.4` unavailable). **CI: success** ([run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480)). No addon/collector file changed |
| Repo-wide | CodeQL | **NOT RUN** locally (GitHub-only). **CI: success** on `3e463f3` ([run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488)) |
| Independent review | Separate reviewer agent over the full diff: 0 critical/high; 3 medium (proxy body buffer, IPv6 rotation, untested matcher) fixed in this change; low items fixed or documented (zone/zones copy "related items", parity skip fails in CI, docs) | done |

Known low residuals from the review: collation differences between JS `localeCompare` and PostgreSQL ordering for exotic names (parity data is ASCII); preview deployments without `RATE_LIMIT_SALT` use a public dev salt; shared NAT users share the 6/10-min challenge budget.

## Foundation results (2026-10-09, historical, superseded counts where noted above)

| Area | Check | Result | Evidence / command |
| --- | --- | --- | --- |
| Dependencies | `npm audit --omit=dev` (web) | **PASS** — 0 vulnerabilities | after replacing gray-matter (4 moderate via js-yaml/argparse/sprintf-js) |
| Static | ESLint (next core-web-vitals + TS, `react/no-danger`, no eval) | **PASS** | `npm run lint` |
| Static | TypeScript strict (web, publisher) | **PASS** | `tsc --noEmit` |
| Unit (web) | Validation bounds, IDs, rate limiter (IP/session/global/challenge/Upstash pipeline), identity hashing and pass cookie, CSP, env fail-closed rules, fixture adapter semantics, formatting, routes, content front matter, Markdown XSS/links/images | **PASS 60/60** (now 115/115, see above) | `npm test` |
| Unit (publisher) | Name sanitizer, Wilson/confidence, projection, contract violation fail-closed (no value echo), rejection and anomaly ratios, dominance, location suppression, synthetic pool kind, deterministic hash, no private identifiers | **PASS 20/20** | `npm test` |
| SQL (private export 0010) | API roles cannot reach the export. Denominators equal raw sums. 1 % quantization. Fine grid rejected. Reader denied 11 private tables. Zero private identifiers/canaries in output | **PASS** | `database/tests/public_projection_export_smoke.sql` |
| SQL (public read model) | Web reader: no table SELECT/INSERT/UPDATE, no admin; bounds on all `web_api` functions; injection string inert. Publisher: no SELECT/DELETE/rollback, RLS blocks writes into the active publication, mismatched finalize rolls back. Supabase API roles: no access | **PASS** | `database/public-read/tests/public_read_model_security.sql` |
| Migration portability | Public read model applied as a **non-superuser** DB owner with `anon`/`authenticated` present (Supabase-like) and as a superuser | **PASS** | second ephemeral cluster |
| Pipeline E2E | Export via projection reader → publish → identical republish no-op → tampered export fails closed → hostile flood fails closed → v2 activates → operator rollback | **PASS** (exit 0) | `scripts/public-pipeline-integration.sh` |
| Build | `next build` with canary secrets in env | **PASS** | |
| Bundle | No canary secret values, DB URLs, prod ref, `service_role`, JWT literals or source maps in `.next/static` (37 files) | **PASS** | `npm run check:bundle-secrets` |
| E2E (fixture) | 10 journeys (search, ID search, URL filters with Back/Forward, blank-enumeration refusal, item↔source↔item, creature levels, pools/disenchant, zone filters, tooltips, 404, content/RSS) · 6 security (nonce CSP on every script, no console/CSP errors, XSS inert, API validation/no-store/no cookies/405, challenge closed, **429 + Retry-After** with a second client unaffected) · 14 axe WCAG 2.2 AA pages · keyboard skip link · SEO (canonical, description, JSON-LD, noindex on preview) · 6 mobile no-overflow | **PASS 44/44** | `npm run test:e2e` |
| E2E (Postgres adapter) | Same journeys and security specs against the real `web_api` schema populated by the publisher | **PASS 16/16** | `FOREVERDB_DATA_SOURCE=postgres … playwright test` |
| Fail-closed config | `FOREVERDB_DEPLOYMENT=production` + fixture ⇒ HTTP 500, no config detail in body, reason only in server log | **PASS** | manual curl |

## Not executed (honest gaps)
- Any provisioning (public DB, Upstash, Turnstile, Vercel, WAF): nothing exists yet.
- Load and abuse testing against a staging deployment. The in-app limiter was only exercised in-process (memory store).
- Real Upstash behaviour (only a mocked REST pipeline was tested), incl. the new challenge limiter and its fail-closed 503.
- Real Turnstile verification (success path covered only with a mocked Siteverify; no call to Cloudflare was made).
- Screen-reader testing (NVDA/VoiceOver) and manual WCAG review. Automated axe catches only part of WCAG.
- Lighthouse / Core Web Vitals measurement on real infrastructure.
- Applying 0010 to production and running the export against real data.
