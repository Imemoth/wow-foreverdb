# Verification results — `web/foundation-mvp`

Executed 2026-10-09 in an isolated cloud workspace (Node 22.22, PostgreSQL 16.15 ephemeral clusters, Chromium 141 via Playwright 1.56.1). **No check ran against production except the read-only audit queries listed in the assessment.** GitHub Actions has **not** run this branch yet: the session could not push.

| Area | Check | Result | Evidence / command |
| --- | --- | --- | --- |
| Dependencies | `npm audit --omit=dev` (web) | **PASS** — 0 vulnerabilities | after replacing gray-matter (4 moderate via js-yaml/argparse/sprintf-js) |
| Static | ESLint (next core-web-vitals + TS, `react/no-danger`, no eval) | **PASS** | `npm run lint` |
| Static | TypeScript strict (web, publisher) | **PASS** | `tsc --noEmit` |
| Unit (web) | Validation bounds, IDs, rate limiter (IP/session/global/challenge/Upstash pipeline), identity hashing and pass cookie, CSP, env fail-closed rules, fixture adapter semantics, formatting, routes, content front matter, Markdown XSS/links/images | **PASS 60/60** | `npm test` |
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
- GitHub Actions CI on this branch (push blocked), including CodeQL.
- Any provisioning (public DB, Upstash, Turnstile, Vercel, WAF): nothing exists yet.
- Load and abuse testing against a staging deployment. The in-app limiter was only exercised in-process (memory store).
- Real Upstash behaviour (only a mocked REST pipeline was tested).
- Real Turnstile verification (endpoint covered only for its closed state).
- Screen-reader testing (NVDA/VoiceOver) and manual WCAG review. Automated axe catches only part of WCAG.
- Lighthouse / Core Web Vitals measurement on real infrastructure.
- Applying 0010 to production and running the export against real data.
