# ForeverDB Web — go-live checklist

Mark an item ✅ only with linked evidence (CI run URL, screenshot, command output). **Production deploy stays blocked until every item in sections A–C is ✅.**

## A. Repository and CI
- [x] PR #22 merged as `b972431d`. `ForeverDB Web & publication pipeline` workflow green on the hardening head `3e463f3` (web, publisher-and-pipeline incl. parity step, codeql, CodeQL code-scanning): [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488)
- [x] Existing workflows still green on `3e463f3`: API security [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423), collector smoke [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480). Companion health is not PR-triggered and was not run
- [ ] Code review by the owner, including `publisher/src/contract.ts` (allowlist) and both SQL files
- [ ] Editorial review of `web/content/*`. Flip `sample: false` only on reviewed articles

- [x] **Hardening PR #45 merged** as `6b49a3f` (2026-10-11). All seven merge-commit checks PASS; Vercel Node 24 production-target deployment READY, protected by Vercel Authentication All Deployments; continues as synthetic Preview-mode demo (`vercel-environments.md` §3 and §6).
- [x] **Required checks enforced on `main`:** existing active ruleset #24853899 pins six checks to GitHub Actions (app ID 15368); branch protected. Separate intentionally failing PR verification remains OPEN (`release-gates.md` §2).
- [ ] **Required checks enforced on `release`:** add the `release` branch to existing ruleset, verify protected state.
- [x] Node.js 24.x aligned across `.node-version`, web/publisher engines, CI and Vercel; validated on PR #45 with Node 24 build and tests.

## B. Data boundary (security-critical)
- [ ] Separate public DB provisioned, Data API disabled (`infrastructure-setup.md` 1–4)
- [ ] `public_read_model_security.sql` PASS on the real public DB
- [ ] **Owner approval** recorded for production 0010. Applied in a maintenance window. In-migration assertions passed. Ledger entry recorded
- [ ] Projection reader login enabled. `public_projection_export_smoke.sql` checks (privileges only, no seeding) adapted and run read-only on production
- [ ] First real `publish --dry-run` reviewed (counts, rejections, anomalies), then a real publish
- [ ] Spot check: future live website item/source pages match the corrected Companion statistics. F-3 SQL and Windows Companion runtime acceptance are both PASS; separate website publication is not yet provisioned.
- [ ] Confirm no website env var references the production project
- [ ] Zone semantics verified on the real public DB: item rows have `observations IS NULL`/`inferred`; `public_read_zone_semantics.sql` adapted to the real data or the schema CHECKs confirmed present. Migration 0001 (edited in place) has not been applied anywhere earlier, otherwise ship a `0002`

## C. Abuse protection and operations
- [ ] Upstash configured. Production boot passes `env.ts`. A 429 is observed on staging with real Upstash
- [ ] Challenge endpoint on staging with real Upstash + Turnstile: 7th POST in 10 min → 429 with no Siteverify traffic; Upstash outage → 503; `TRUSTED_IP_HEADER` is a header the platform overwrites (`x-real-ip` / `cf-connecting-ip`); `RATE_LIMIT_SALT` set; platform body limit configured (Next buffer capped at 8 kB)
- [ ] Vercel WAF/bot rules and spend alerts configured (screenshots)
- [ ] Staging load test (not production): search p95 and DB CPU recorded; limits tuned
- [ ] Freshness monitor and alerting live. Rollback rehearsed with `pub_admin.activate_publication`
- [ ] Security headers verified on the production domain (CSP, HSTS, nosniff, frame-ancestors)

- [ ] Deployment protection **full scripted external test** remains PENDING: `node web/scripts/verify-deployment.mjs <url> --expect protected`. Owner's 2026-10-11 anonymous/incognito browser checks **PASS** on production alias homepage, `/api/v1/meta`, and PR #45 Preview (all required Vercel login); this does not cover every path.
- [ ] No custom domain attached until the approved go-live. Vercel Authentication currently uses **All Deployments**, but new-domain access and indexing must still be reverified before public release.
- [ ] Production-promotion control: `release` branch CREATED at stable #45 commit `6b49a3f`; GitHub release protection and Vercel Production Branch tracking still require owner setup and confirmation **before** Account System V1 changes reach `main`.
- [ ] Production-mode verification with `verify-deployment.mjs --expect production` after go-live, including `X-ForeverDB-Deployment: production`, no synthetic banner, real publication banner

## D. Product quality
- [ ] Manual screen-reader pass of home, search, item, creature, zone
- [ ] Lighthouse ≥ 90 on performance/accessibility/SEO for home and item pages
- [ ] `robots.txt`/sitemap reviewed on production; preview remains noindex
- [ ] Download page links to an official signed release, once one exists

## E. Explicitly out of scope for go-live
Accounts, Guildbook on web, comments/UGC, map artwork, quest catalog.

## F. Status ledger (2026-10-10)
| Gate | State |
| --- | --- |
| P1 challenge limiter + body cap, P2 zone semantics | Implemented · Locally tested · **GitHub CI verified on `3e463f3`** ([run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488)) |
| Live Upstash, live Turnstile, staging load test | Pending infrastructure (no PASS claimed) |
| Apply `0010` to production; enable RLS on `private.foreverdb_api_budgets` | Pending production approval / out of scope of PR #22 |
| F-3 Companion denominator fix (`0011`) | **F3_FULLY_VERIFIED** (2026-10-10; PR #37 merged as `6d0df83`; production ledger `20261010151518`; 5/5 Windows Companion Search UI checks PASS; see `docs/f3-observed-rate-denominator.md`) |
| Preview hardening (explicit designation, noindex everywhere, fail-closed hosted config, CI split + aggregate gate, Node 24 pin) | **Implemented · Locally tested** · GitHub CI result recorded in `verification-results.md` |
| Vercel variables, Production Branch, unauthenticated protection test, ruleset enforcement | **PENDING owner action** (connector cannot read or write variables; no ruleset API) |
| Production mode (`FOREVERDB_DEPLOYMENT=production`) | **BLOCKED** until A–C are ✅ |
