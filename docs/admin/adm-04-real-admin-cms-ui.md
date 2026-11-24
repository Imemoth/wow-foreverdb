# ADM-04: real Admin CMS UI (isolated, development only)

Status: **development only, ready for the Owner's acceptance.** The approved six-screen Admin UI is connected to the real CMS backend in a **disposable, isolated** environment.
This is not an activation: no hosted Supabase migration, no production deployment, no real staff, no production publication, no `release` change.
ADM-03C (PR #206) and the ADM-03B/03C backend hotfix (PR #210, migration 0028) are merged into `main` and this branch has been reconciled with both (regular merges, no rebase, no force-push): the real ledger, worker and public
projection are used directly from the repository. The PR is not merged without a separate Owner decision.

## What changed, file by file

### Database (additive, read-only)

| File | Responsibility |
| --- | --- |
| `database/migrations/0027_editorial_admin_reads.sql` | Eight read-only functions the ADM-03B contract lacks: `fdb_cms_context`, `fdb_cms_articles`, `fdb_cms_article_detail`, `fdb_cms_revision`, `fdb_cms_audit` (public, `authenticated` only) and three private helpers. Every one re-runs the **same** live gate as the writes (`admin_private.editorial_actor`: live AAL2 session, active policy, staff status, scoped role/grant, revocation, TOTP ≤ 15 min). `SECURITY DEFINER`, owned by the no-login `admin_executor`, `search_path=''`, no table grant to any API role. Pre-flight requires 0025 and refuses a second apply. The delivery state is read through `to_regclass` so the migration works with and without the ADM-03C ledger (without it, the inactive boundary: `blocked`). Reads write nothing and never return draft bodies in lists, session ids, tokens or keys. |
| `database/rollback/0027_editorial_admin_reads_rollback.sql` | Guarded drop of exactly those functions; the 0025 boundary is untouched. |
| `database/tests/admin_cms_reads/{run.sh,reads.sql}` | Disposable SQL suite: scoping, ordering, limits, no body leak, audit paging, ACL/owner/`search_path` pins, stale TOTP, revoked session, suspension, forged/expired claims, anon denial, delivery states with and without the ledger, rollback. |

### Server-only adapter (`web/src/lib/admin/`)

| File | Responsibility |
| --- | --- |
| `cms/schemas.ts` | Strict zod input for the seven actions (database limits or stricter, raw HTML / `javascript:` / `data:` / non-https refused, unknown keys refused so no identity, role, environment or permission can be supplied) and strict **output** schemas: an unexpected column fails closed instead of reaching the browser. |
| `cms/rpc.ts` | The only module that names `/rest/v1/rpc`. Closed over the reviewed function names, sends the **staff member's own verified token** and the publishable key, `redirect: manual`, 8 s timeout, 2 MiB bounded response, SQLSTATE/closed-message classification (never database text), write-with-lost-reply = *unknown outcome*, read = *unavailable*. |
| `cms/route.ts`, `app/admin/api/cms/[action]/route.ts` | POST-only action endpoint: Admin runtime ready, allow-listed action, sealed Admin cookie, origin, JSON, session-bound signed double-submit CSRF, 256 KiB bounded body, strict validation, rate limit (fails closed), **live session re-verification on every call**, then the RPC. |
| `cms/service.ts` | Server-component reads on the same verified session. The access token never leaves the server. |
| `cms/ids.ts`, `cms/diff.ts` | Deterministic article id from the request id (a retried create hits the same article); isomorphic revision diff. |
| `session.ts` (modified) | `resolveAdminSessionToken` returns the verified token to the server-only adapter; `resolveAdminSession` is unchanged in behaviour. |
| `../account/limits.ts`, `../../proxy.ts`, `../../../next.config.ts` | `admin_cms_write/read` budgets; `/admin/**` is no-store, noindex, no visitor cookie; request-body buffer raised from 8 kB to 256 kB for article bodies. |
| `../account/auth-client.ts`, `app/account/api/admin/mfa/enroll/route.ts` | **Bug found by the real stack:** pinned GoTrue answers a TOTP enrolment with a ~280 KB SVG QR code; the website capped replies at 64 KiB / 8 KiB, so enrolment returned 503 in a real browser. The image is now bounded (512 KiB), parsed and never forwarded (the UI shows the secret). |

### UI (`web/src/components/admin/`, `web/src/app/admin/`)

The visual architecture of Admin UI Preview V1 is reused (copied and adapted; production code never imports `@/admin-preview`). Navigation: Dashboard, Articles / News,
Editorial Review Queue, Staff & Roles, Audit Log, Settings.

| Screen | Real behaviour |
| --- | --- |
| Dashboard | Counts and recent audit events from the database; your access (create / read / audit). |
| Articles | List with search/status/classification filters; New draft; detail with Overview, Revisions (+ field and line diff), Review evidence, Delivery tabs; editor mirroring the database limits and a safe Markdown preview. |
| Workflow actions | Submit, Return, Reject (note ≥ 5 characters), Approve highlighted, Publish, Unpublish. Buttons are enabled from the database's `permitted` flags **and** the article state; the database re-checks everything. One idempotency key per intent, kept only while the outcome is unknown. |
| Review Queue | Awaiting review, awaiting independent approval, ready to publish, delivery pending/failed/cancelled. |
| Staff & Roles | **Informational.** Every management control is disabled with a "Not available" badge. No staff-management API exists and none is invented. |
| Audit Log | Real authorized `news.*` events; a clear "not authorized" state for everyone else. |
| Settings | Session identity, sign out, integration status. Nothing editable. |

Status is derived only from real state: a publish is shown as **Published** only when its delivery receipt says `delivered`; `blocked/eligible/claimed` = *pending*; `retryable` = *failed*;
`cancelled/superseded` = *cancelled*; an unpublish is *Unpublished* only after its receipt (tombstone).

### Isolated environment and verification

| File | Responsibility |
| --- | --- |
| `web/tests/admin-cms-stack/*` | `up.sh` (PG16 + real GoTrue + real PostgREST + migrations + separate public-read DB), `build-site.sh`, `serve.sh`, `deliver.sh`, `seed-demo.mjs`, `totp.mjs`, `down.sh`, `README.md`. |
| `web/playwright.admin-cms.config.ts`, `web/tests/admin-cms-e2e/*.spec.ts` | Browser acceptance through the real UI, real GoTrue TOTP and the real worker. |
| `web/tests/unit/admin-cms-adapter.test.ts` | Adapter, schemas, Markdown safety, status derivation, static boundary (no key/secret/table names/`dangerouslySetInnerHTML` in Admin code, client components never import server modules, no feature flag). |
| `database/tests/admin_cms_reads/combined_0027_0028.sql` | 0027 and 0028 together: a stale revision is `PT409` through the RPC the UI calls, nothing is written, the reads still answer from the unchanged head. |
| `.github/workflows/admin-cms-ui.yml` | Exact-HEAD CI: 0027 + 0028 SQL on PG 16 and 17 in four combinations (with/without the ledger, 0028 after and before 0027) and the end-to-end job. |

## Security model

* **No browser-held secret.** The browser has an HttpOnly sealed cookie and a CSRF token. The access token, database URL, worker credentials and MAC key never reach client code (a static test and the bundle-secret scan enforce it).
* **No direct private access.** The browser cannot reach `editorial_private.*`/`admin_private.*` or the internal functions; the e2e suite asserts 401/403/404 with a real AAL2 token.
* **Server-side authorization on every call.** Cookie → live GoTrue user → `fdb_admin_entry_ready` → the RPC re-runs the evaluator in the same transaction. A revoked session, expired grant or TOTP older than 15 minutes is refused at the next request (tests).
* **Fail closed.** Missing policy, grants or backend configuration produce a denial/unavailable state, never an empty CMS. A lost reply on a write is an *unknown outcome*; retrying reuses the same request id and cannot apply twice.
* **No bypass flag.** Admin is enabled only by the existing predicate (local mode, not hosted, `FOREVERDB_DEPLOYMENT=local`; `HOSTED_ADMIN_AUTH_APPROVED` stays `false`). A static test pins both and forbids any new flag.
* **Safe content.** react-markdown renders elements (no raw HTML), images/embeds are not allowed, links are absolute https only with `rel="noopener noreferrer nofollow ugc"`; the same rules are enforced by the schema and the database.
* **No private draft through public APIs.** Public pages read only the separate public-read projection (ADM-03C); the e2e suite checks drafts, intents and rejected articles are absent from article, archive, RSS and sitemap.

## ADM-03C integration

ADM-03C is native in the repository: migration 0026 (delivery ledger), public-read 0013 (projection), `cms-delivery/` (one-shot worker) and the website's public adapter. The harness applies 0026 and 0013 from `database/` and runs `cms-delivery/src/once.mjs` from the checkout; there is no pinned fetch, no overlay and no copy of the repository. The inactive boundary stays tested: `database/tests/admin_cms_reads/run.sh` runs 0027 without the ledger (every intent *blocked*) and, with `FDB_ADMIN_WITH_DELIVERY=1`, with it.

## Backend hotfix integration (PR #210, migration 0028)

The three defects that this PR originally had to work around are fixed in `main` and are **no longer tolerated anywhere in the tests**:

| Defect (fixed by 0028 / the worker change) | What this PR did before | What it does now |
| --- | --- | --- |
| A stale edit/submit raised SQLSTATE `40001`, which the pinned PostgREST retries forever | The adapter answered stale revisions from the head before calling the database | The adapter classifies `PT409` (HTTP 409) as *stale*, and still `40001` for a database without 0028. The head pre-check stays (it avoids a pointless round trip) but the database now also answers the narrow race promptly. Spec `10-stale-race` calls real PostgREST directly and through the adapter. |
| Every highlighted publication failed (`ap.approval_id` ambiguous) | Spec 08 accepted the failure and retired the intent | Spec 08 requires: independent approval, worker delivery, signed receipt in the private ledger, and the article page, archive, RSS and sitemap. A failed publication fails the test. |
| One failing intent aborted the whole worker pass | Spec 09 ran last and `retireStuckIntents` freed the worker | Spec 09 runs a failing intent **and** an unrelated valid one in the same pass: the failure is isolated (state `retryable`, attempt 1, `missing_asset`, one audit event), the valid one is public everywhere, a second pass never delivers it twice, and the failing one recovers when its cause is fixed. No ordering workaround or fixture cleanup remains. |

`runWorker()` in the tests is **strict**: any failure the worker reports (isolated or fatal) fails the test; only the failure scenario uses `runWorkerPass()` and then inspects the report. Fatal-error, receipt-recovery and compensation guarantees are not re-implemented here: they are covered by the worker tests of the hotfix (`cms-delivery/test`, `database/tests/admin_cms_repair`), which run in CI on this branch too because the code is the same.

Migrations 0027 and 0028 are additive and order independent; the native stack applies `0025, 0026, 0027, 0028`. 0028 is refused a second time (pre-flight).

## How to open and test the real isolated CMS (Product Owner acceptance)

This is the **real** Admin (`/admin`), not the synthetic Admin Preview: real PostgreSQL, real GoTrue accounts with real TOTP, real PostgREST, the real ADM-03B/03C database code (migrations 0025-0028) and the real delivery worker. Everything is local and throw-away. Nothing below contacts Supabase, Vercel or any hosted service, and no real person is involved.

### Prerequisites

* A **throw-away** PostgreSQL 16 server you can connect to as a superuser on a loopback address (for example `docker run -d --name fdb-pg -p 5432:5432 -e POSTGRES_PASSWORD=local-test-password postgres:16`). `up.sh` refuses any non-loopback host and drops the disposable databases/roles of earlier runs. **Never point it at a real database.**
* Go (to build the pinned GoTrue), Node 24, `curl`, `psql` and `createdb/dropdb` client tools.
* From the repository root: `npm ci --prefix web`.

### Start

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=local-test-password   # the throw-away server
database/tests/account/build-gotrue.sh "$HOME/stack-bin/gotrue"                      # real GoTrue at the pinned commit
# PostgREST v12.2.12 (linux-static-x86-64): download, verify sha256 5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5, extract `postgrest` into $HOME/stack-bin
export GOTRUE_BIN=$HOME/stack-bin/gotrue POSTGREST_BIN=$HOME/stack-bin/postgrest
npm ci --prefix cms-delivery --ignore-scripts                                          # worker dependency
web/tests/admin-cms-stack/up.sh                                                        # databases, migrations 0025-0028, GoTrue, PostgREST
web/tests/admin-cms-stack/build-site.sh                                                # production build of this checkout
cd web && node tests/admin-cms-stack/seed-demo.mjs                                     # four demo staff accounts; prints their e-mail addresses
tests/admin-cms-stack/serve.sh                                                         # leave running
```

**URL:** `http://localhost:3220` (Admin at `/admin`, sign-in at `/account/login`). Stop with Ctrl-C and `web/tests/admin-cms-stack/down.sh`.

### Demo roles and the safe sign-in procedure

`seed-demo.mjs` creates four **synthetic** accounts (`@example.test`) with a public test password (`DEMO_PASSPHRASE` in `seed-demo.mjs`: `demo-staff-passphrase-public-test-value`) and an enrolled TOTP factor each:

| Account | Role | Can |
| --- | --- | --- |
| Editor | Editor | write, submit; cannot approve its own highlighted article, cannot publish, no audit |
| Second Editor (reviewer) | Editor | return / reject another editor's submission |
| Administrator (approver) | Administrator | approve highlighted content, unpublish, read the audit log; cannot publish |
| Owner (publisher) | Owner | publish, unpublish, audit |

Sign in: open `/account/login` (use a separate private window per account), enter the account's e-mail and the demo password, press **Request TOTP challenge** in *Admin authentication* and enter the code printed by `node tests/admin-cms-stack/totp.mjs <email>` (run from `web/`; it reads the secret from the throw-away database and behaves like an authenticator app). A code works once per 30 seconds: wait for the next one when you re-use an account. You land in `/admin`. Admin stays usable for 15 minutes after the TOTP step, then asks you to verify again (this is intended).

### Walkthrough and expected results

| # | Do | Expect |
| --- | --- | --- |
| 1 | Editor: **Articles → New draft**, fill title, summary, Markdown, save. Reload. | The article persists as *Draft*, revision r1. A draft is **404** at `/news/<slug>`. |
| 2 | **Edit**, change the summary, save. Open the **Revisions** tab. | New revision r2; both revisions listed, with a diff. |
| 3 | **Stale edit:** open the same article's *Edit* in two tabs, save in tab 1, then save in tab 2. | Tab 2 shows "Out of date" **at once** (no spinner that never ends); *Reload* shows tab 1's text; only 2 revisions exist. |
| 4 | Markdown safety: put `[bad](ftp://x)`, `![img](https://example.com/x.png)` and `<script>` in the body. | Raw HTML, images and non-https links are not rendered; good https links get `rel="noopener noreferrer nofollow ugc"`. |
| 5 | Editor: **Submit for review**. Second Editor (other window): open it, **Return** with a note (or **Reject**). | Status changes to *Returned* / *Rejected* with the note; the author can edit and submit again. |
| 6 | Editor: create a **Featured** (highlighted) article, submit it. Try **Approve** as the Editor. | Refused: independent approval is required. |
| 7 | Administrator: open it, **Approve**. | *Approved*. |
| 8 | Owner: **Publish**. | *Publish pending*; `/news/<slug>` is still **404** (an intent is not publication). |
| 9 | Another terminal, from the repository root: `web/tests/admin-cms-stack/deliver.sh` | The worker prints its JSON report with `"failures":[]` and `delivered ≥ 1`. |
| 10 | Reload the article in Admin. Open **Delivery**. | *Published*; delivery `delivered` with one attempt. `/news/<slug>`, `/news`, `/news/rss.xml`, `/sitemap.xml` all show the highlighted article. (This is the path that failed before the hotfix.) |
| 11 | Run `deliver.sh` again. | `delivered: 0`: nothing is delivered twice. |
| 12 | Owner or Administrator: **Unpublish**, then `deliver.sh`. | *Unpublished*; `/news/<slug>` is 404 (tombstone), gone from archive, RSS and sitemap; the slug stays reserved. |
| 13 | Owner/Administrator: **Audit Log**. Editor: open `/admin/audit`. | Real `news.*` events for every action above, without draft text or secrets; the Editor gets "Not authorized". |
| 14 | **Staff & Roles**, **Settings**. | Informational; every control is disabled (no staff-management API exists yet). |
| 15 | Wait 15 minutes without re-verifying TOTP, then reload. | Admin asks for TOTP again (fail closed). |

The failure scenarios (a failing delivery with an unrelated valid one in the same worker pass, retry state, revoked sessions, expired grants, forged requests) need database fixtures and are therefore verified by the automated suite, not by hand: `cd web && npx playwright test -c playwright.admin-cms.config.ts` (34 browser tests against the same stack; it starts the site itself, so stop `serve.sh` first).

### Limitations of this environment

No staff management or media upload; the worker runs only when you run `deliver.sh` (no scheduler); the stack uses a fixed public test MAC key and a superuser `SET ROLE` worker shortcut; the home page's "latest news" strip reads the news-collector projection (public-read migration 0011), which this stack does not apply, so the site logs a harmless `public_db_error` (`news_cards`, SQLSTATE 42883) on `/` and shows no collector news (the CMS routes `/news`, `/news/<slug>`, RSS and sitemap are unaffected); hosted Supabase is not exercised (see below). **This is development-only evidence and does not claim production readiness.**

## Remaining functional gaps

* **No staff management.** No API to invite, assign, grant, suspend or revoke; staff are provisioned by test-only SQL here. Staff & Roles stays informational by design.
* **No media upload or registration.** Existing rights-verified asset references are preserved in edits; none can be added from the UI.
* **Delivery is manual in the harness.** The worker is a one-shot process run by the test/operator; no scheduler exists (ADM-03C is merged inactive).
* **Audit is `news.*` editorial events only** and requires the audit permission; staff-lifecycle audit is not exposed.
* **Review queue is derived from the articles list** (100 newest); there is no server-side queue or pagination UI yet.
* **No comment threads, scheduled publication, bulk actions or search beyond title/slug** (not part of the ADM-03B contract).

## Remaining security gaps and activation gates (not approved by this PR)

* **Hosted activation is untested here.** Real Supabase Auth settings, Kong/new-style keys, managed Auth schema compatibility, the migration operator's privileges and PostgREST pooling were not exercised. `HOSTED_ADMIN_AUTH_APPROVED` stays `false`; Admin refuses to run outside the local deployment.
* **Denial audit is not durable.** A denied call raises `42501` and rolls back, so the denial itself is not written to the audit chain (ADR-020 gate, inherited from ADM-03B).
* **TOTP freshness (15 min) applies to reads as well as writes**, by design of the shared gate: an idle editor must re-verify to even read.
* **Cross-database revocation window.** Private authorization and the public projection are separate databases; a revoke between the final recheck and the public commit can briefly leave content public. ADM-03C's signed 2-minute claims and tombstones limit but do not remove it; no maximum has been accepted by the Product Owner.
* **MAC key and worker credentials** in the harness are public test constants and a superuser `SET ROLE` shortcut; hosted activation needs separately provisioned random keys and real worker roles.
* **Companion MFA session compatibility** (a TOTP step-up invalidates a registered Companion AAL1 session) is inherited and not mitigated here.
* **Dependencies.** `web/package.json` and the lockfile are identical to `main` (Next.js 16.4.6, reviewed); no exception to the dependency audit is used or needed.
* **Pre-existing Admin entry bug fixed here** (QR size, above) shows the account-side Admin flow had never run against the real pinned GoTrue in a browser; other untested edges may exist.
* **Roles in the harness are minimal** (Editor, Administrator, Owner, Moderator); lifetime, review-due and emergency-revoke flows of the staff lifecycle are not exercised from the UI.

## Remaining operational issues (recorded separately; none is introduced or approved by this PR)

1. **Eligible intents that are never claimed.** `cms_dispatch_qualify` moves a ledger row to `eligible`, but a later `qualify` accepts only `blocked`, `retryable` or an expired claim, while `cms_dispatch_candidates` still lists `eligible` rows. A pass interrupted between `qualify` and `claim` leaves that intent `eligible`, silently skipped. It blocks nothing and nothing becomes public; it needs its own decision (ADM-03C follow-up). Not reproduced in the browser suite.
2. **Unlimited retry attempts without backoff.** A permanently failing intent is retried on every pass, with one audit event per attempt, no ceiling and no backoff. Monitoring must alert on repeated `retryable` failures (an existing ADM-03C activation gate). The browser suite shows the attempt counter and audit event; it does not and cannot bound them.
3. **Hosted Supabase and Companion MFA compatibility.** Real Supabase Auth settings, Kong/new-style keys, managed Auth schema compatibility, the migration operator's privileges and PostgREST pooling are untested. A TOTP step-up invalidates a registered Companion AAL1 session (inherited, unmitigated).
4. **Revocation exposure and cache policy.** The cross-database window between the final authorization recheck and the public commit is unmeasured; no maximum has been accepted. The RSS feed answers `Cache-Control: no-store` and the sitemap is `force-dynamic` when the public CMS projection is on; no explicit cache policy is set for the article page and archive, and the time a revoked or unpublished article could remain visible through any cache (CDN, browser) has not been measured or accepted. That needs a measured maximum and a cache policy before activation.
5. **Worker credentials, MAC management, scheduler and durable denial audit.** The harness uses public test constants and a superuser `SET ROLE` shortcut; hosted activation needs separately provisioned random MAC keys and rotation, real worker roles and credentials, a scheduler with alerting, and a durable denial audit (a denied call rolls back, so the denial itself is not recorded).
