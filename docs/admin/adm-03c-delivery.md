# ADM-03C: isolated CMS delivery implementation

Status: development only. ADR-020 and ADM-03A govern product policy and article identity. This document describes the new code paths; it does not approve public activation.

## File-by-file design

| File | Responsibility |
| --- | --- |
| `database/migrations/0026_editorial_delivery_control.sql` | Inactive dispatch ledger, live eligibility checks, serialized claims, acknowledgements, cancellation, compensation and audit. |
| `database/public-read/migrations/0013_cms_projection.sql` | Separate private-to-public projection, immutable revision snapshots, generation-ordered pointer, tombstones, signed receipts and bounded website RPCs. |
| `cms-delivery/src/once.mjs` | Dedicated one-shot worker; validates content, actual asset bytes, original authorization, committed public receipt, and private acknowledgement. |
| `web/src/lib/content/cms-public.ts` | Read-only website adapter, enabled only with explicit disposable local configuration. |
| `web/src/components/{NewsArchive,ArticleViews}.tsx`, `web/src/components/content/ArticleReader.tsx`, `web/src/app/news/rss.xml/route.ts`, `web/src/app/sitemap.ts` | Apply the same public projection to article, archive, SEO, feed and sitemap surfaces. Git editorial content and Collector routes remain separate. |
| `database/tests/admin_cms_delivery/`, `cms-delivery/test/`, `.github/workflows/admin-cms-delivery.yml` | Disposable PostgreSQL 16/17 negative and two-database worker checks. |

## Boundaries and lifecycle

The two new worker roles are `NOLOGIN` and cannot read authorization or projection tables directly. They can call only narrow definer functions in their respective databases. API callers and existing Collector/publisher roles receive no new access. Both private delivery control and MAC key tables start empty or disabled. A reviewed, random 32-byte key must be provisioned independently to both databases in a separate activation ceremony. The worker never reads that key. Its claim carries a two-minute HMAC authorization of intent ID, payload hash and expiry; the public database recomputes the payload hash and MAC before writing. The public database signs its committed receipt, which the private database verifies before moving `published_revision_id`. A worker with only its two call roles cannot fabricate either half.

The public transaction inserts an immutable revision snapshot, advances the article generation and writes its receipt atomically. The private transaction verifies that receipt, updates the article pointer and appends audit atomically. An expired private lease is recovered by reading the committed public receipt. A claim refused after revocation is cancelled and creates an ordered tombstone generation; a revocation discovered after public commit queues the same compensation. The worker retries unresolved failures and reconciles delivered articles against current authorization. Failed delivery leaves the previously published revision in place until a later successful generation changes it.

The public projection holds only article IDs, slugs, published revision snapshots, generations and receipts. It excludes drafts, staff, grants and approval history. Slugs are reserved in the private contract; a CMS/Git collision fails closed in the website. Collector identities, existing `/news/entry/{slug}` URLs, RSS GUIDs and observation publishing stay unchanged.

The website adapter is off unless `FDB_CMS_DISPOSABLE=1`, `FOREVERDB_DEPLOYMENT=local`, a loopback public-read PostgreSQL URL and the existing `foreverdb_web_reader` identity are present. CMS article and list reads are request bound; the RSS response uses `no-store` while enabled. A tombstone yields 404. Production builds retain the Git and Collector behavior. This is not an activation flag for hosted environments.

## Local verification

Run `npm ci --prefix cms-delivery --ignore-scripts`, then `npm test --prefix cms-delivery`. Run `FDB_CMS_PG_IMAGE=postgres:16 bash database/tests/admin_cms_delivery/run-docker.sh` and repeat with `postgres:17`. For the two-database worker path, add `FDB_CMS_WORKER_TEST=1`; the runner creates only disposable containers and injects a synthetic, fixed test key. Never reuse that value outside tests.

The SQL tests deny table access to API/worker roles, assert forced RLS, reject generation gaps, conflicting retries and stale versions, and verify tombstones. The worker test rejects forged delivery MACs and receipts, restores a lost private acknowledgement, verifies byte hashes, and confirms revocation queues and delivers a compensating tombstone. Existing Admin CMS, GoTrue/PostgREST, web and mandatory CI remain required on the exact PR HEAD.

## Recovery, rollback and activation gates

No automatic rollback is provided after any real CMS generation is delivered. Keep immutable receipts and revision history; recover an interrupted worker using `cms_receipt` and `cms_dispatch_recover`, then reconcile. If a public write succeeded and a private acknowledgement failed, block further delivery for that article until receipt recovery succeeds. If delivery fails or a revocation leaves a stale public article, alert an operator and run compensation; do not delete history. A rollback of the new migrations is safe only while control remains disabled, MAC keys are absent, and no delivery state, projection row or receipt exists. Once content exists, use an explicit reviewed forward recovery migration.

The two databases cannot share one transaction. A revoke after the final private recheck and before the public commit can briefly expose content. Signed claims expire after at most two minutes, and ordered tombstones limit replay, but neither removes the exposure window. A separately approved target-configured staging run must measure time from revoke to public tombstone and from unpublish to absence across article, archive, RSS, sitemap and CDN. The Product Owner has not accepted a maximum window. Monitoring must alert on overdue claims, repeated retryable failures, missing receipts, failed compensation and any mismatch between private and public generations.

Before hosted activation: independent review of SQL ownership/ACL/RLS, target Supabase migration privileges and managed Auth compatibility, separate worker credentials and 32-byte MAC key provisioning/rotation, durable denial audit and privacy review, measured cross-database exposure, approved cache policy, Companion MFA session compatibility and mitigation, and explicit Owner authorization for hosted migrations, staff bootstrap, policy activation and deployment. Do not infer those approvals from a green development PR.

## Admin UI connection plan

The approved Admin UI Preview screens remain a UX baseline. A later, separate adapter slice will replace synthetic actions with the existing authenticated ADM-03B article RPCs, then read authoritative intent and delivery states for status. It must use the ADM-01B live session, MFA freshness, scoped evaluator and revocation controls. The browser must never receive worker URLs, MACs, private database credentials or direct projection write access. An isolated browser acceptance run should cover create, edit, submit, independent approval, publish intent, delivered visibility, unpublish, denial and recovery before another Owner UI acceptance request.
