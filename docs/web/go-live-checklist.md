# ForeverDB Web — go-live checklist

Mark an item ✅ only with linked evidence (CI run URL, screenshot, command output). **Production deploy stays blocked until every item in sections A–C is ✅.**

## A. Repository and CI
- [ ] PR #22 open. `ForeverDB Web & publication pipeline` workflow green **on the hardening commit** (web, publisher-and-pipeline incl. new parity step, CodeQL). Earlier head `fde9ae6` was reported green by the owner; the new commit is unverified until pushed. Link the run URL
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
| P1 challenge limiter + body cap, P2 zone semantics | Implemented · Locally tested · **GitHub CI: not verified for this commit** |
| Live Upstash, live Turnstile, staging load test | Pending infrastructure (no PASS claimed) |
| Apply `0010` to production; enable RLS on `private.foreverdb_api_budgets`; F-3 denominator fix | Pending production approval / out of scope of PR #22 |
