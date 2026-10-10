# ForeverDB Web — go-live checklist

Mark an item ✅ only with linked evidence (CI run URL, screenshot, command output). **Production deploy stays blocked until every item in sections A–C is ✅.**

## A. Repository and CI
- [x] PR #22 open. `ForeverDB Web & publication pipeline` workflow green on the hardening head `3e463f3` (web, publisher-and-pipeline incl. parity step, codeql, CodeQL code-scanning): [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207488)
- [x] Existing workflows still green on `3e463f3`: API security [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207423), collector smoke [https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480](https://github.com/Imemoth/wow-foreverdb/actions/runs/38057207480). Companion health is not PR-triggered and was not run
- [ ] Code review by the owner, including `publisher/src/contract.ts` (allowlist) and both SQL files
- [ ] Editorial review of `web/content/*`. Flip `sample: false` only on reviewed articles

## B. Data boundary (security-critical)
- [ ] Separate public DB provisioned, Data API disabled (`infrastructure-setup.md` 1–4)
- [ ] `public_read_model_security.sql` PASS on the real public DB
- [ ] **Owner approval** recorded for production 0010. Applied in a maintenance window. In-migration assertions passed. Ledger entry recorded
- [ ] Projection reader login enabled. `public_projection_export_smoke.sql` checks (privileges only, no seeding) adapted and run read-only on production
- [ ] First real `publish --dry-run` reviewed (counts, rejections, anomalies), then a real publish
- [ ] Spot check: item/source pages match Companion figures where denominators agree (beware F-3 until `0011` is applied in production; the website's own figures already use the correct denominator)
- [ ] Confirm no website env var references the production project
- [ ] Zone semantics verified on the real public DB: item rows have `observations IS NULL`/`inferred`; `public_read_zone_semantics.sql` adapted to the real data or the schema CHECKs confirmed present. Migration 0001 (edited in place) has not been applied anywhere earlier, otherwise ship a `0002`

## C. Abuse protection and operations
- [ ] Upstash configured. Production boot passes `env.ts`. A 429 is observed on staging with real Upstash
- [ ] Challenge endpoint on staging with real Upstash + Turnstile: 7th POST in 10 min → 429 with no Siteverify traffic; Upstash outage → 503; `TRUSTED_IP_HEADER` is a header the platform overwrites (`x-real-ip` / `cf-connecting-ip`); `RATE_LIMIT_SALT` set; platform body limit configured (Next buffer capped at 8 kB)
- [ ] Vercel WAF/bot rules and spend alerts configured (screenshots)
- [ ] Staging load test (not production): search p95 and DB CPU recorded; limits tuned
- [ ] Freshness monitor and alerting live. Rollback rehearsed with `pub_admin.activate_publication`
- [ ] Security headers verified on the production domain (CSP, HSTS, nosniff, frame-ancestors)

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
| F-3 Companion denominator fix (`0011`) | **MERGED / PRODUCTION MIGRATION PENDING** (PR #37 merged as `6d0df83`, not applied; see `docs/f3-observed-rate-denominator.md`) |
