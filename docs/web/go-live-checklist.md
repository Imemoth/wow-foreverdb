# ForeverDB Web — go-live checklist

Mark an item ✅ only with linked evidence (CI run URL, screenshot, command output). **Production deploy stays blocked until every item in sections A–C is ✅.**

## A. Repository and CI
- [ ] PR from `web/foundation-mvp` opened. `ForeverDB Web & publication pipeline` workflow green (web, publisher-and-pipeline, CodeQL)
- [ ] Existing workflows still green (API security, collector smoke, Companion health), proving the Companion and addon are unaffected
- [ ] Code review by the owner, including `publisher/src/contract.ts` (allowlist) and both SQL files
- [ ] Editorial review of `web/content/*`. Flip `sample: false` only on reviewed articles

## B. Data boundary (security-critical)
- [ ] Separate public DB provisioned, Data API disabled (`infrastructure-setup.md` 1–4)
- [ ] `public_read_model_security.sql` PASS on the real public DB
- [ ] **Owner approval** recorded for production 0010. Applied in a maintenance window. In-migration assertions passed. Ledger entry recorded
- [ ] Projection reader login enabled. `public_projection_export_smoke.sql` checks (privileges only, no seeding) adapted and run read-only on production
- [ ] First real `publish --dry-run` reviewed (counts, rejections, anomalies), then a real publish
- [ ] Spot check: item/source pages match Companion figures where denominators agree (beware F-3)
- [ ] Confirm no website env var references the production project

## C. Abuse protection and operations
- [ ] Upstash configured. Production boot passes `env.ts`. A 429 is observed on staging with real Upstash
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
