# ADM-04: real Admin CMS UI (isolated, development only)

Status: **development only, Draft.** The approved six-screen Admin UI is connected to the real CMS backend in a **disposable, isolated** environment.
This is not an activation: no hosted Supabase migration, no production deployment, no real staff, no production publication, no `release` change.
ADM-03C (PR #206) is not merged; it is used only as a clearly identified development dependency (below). This PR must not be merged until ADM-03C has
landed in `main` and this branch has been reconciled against it.

## What changed, file by file

### Database (additive, read-only)

| File | Responsibility |
| --- | --- |
| `database/migrations/0027_editorial_admin_reads.sql` | Eight read-only functions the ADM-03B contract lacks: `fdb_cms_context`, `fdb_cms_articles`, `fdb_cms_article_detail`, `fdb_cms_revision`, `fdb_cms_audit` (public, `authenticated` only) and three private helpers. Every one re-runs the **same** live gate as the writes (`admin_private.editorial_actor`: live AAL2 session, active policy, staff status, scoped role/grant, revocation, TOTP ≤ 15 min). `SECURITY DEFINER`, owned by the no-login `admin_executor`, `search_path=''`, no table grant to any API role. Pre-flight requires 0025 and refuses a second apply. The delivery state is read through `to_regclass` so the migration works with and without ADM-03C's ledger (without it: `blocked`). Reads write nothing and never return draft bodies in lists, session ids, tokens or keys. |
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
| `web/tests/admin-cms-stack/*` | `up.sh` (PG16 + real GoTrue + real PostgREST + migrations + separate public-read DB), `build-site.sh`, `adm03c.pin` + `fetch-adm03c.sh` (pinned development dependency), `serve.sh`, `deliver.sh`, `seed-demo.mjs`, `totp.mjs`, `down.sh`, `README.md`. |
| `web/playwright.admin-cms.config.ts`, `web/tests/admin-cms-e2e/*.spec.ts` | Browser acceptance through the real UI, real GoTrue TOTP and the real worker. |
| `web/tests/unit/admin-cms-adapter.test.ts` | Adapter, schemas, Markdown safety, status derivation, static boundary (no key/secret/table names/`dangerouslySetInnerHTML` in Admin code, client components never import server modules, no feature flag). |
| `.github/workflows/admin-cms-ui.yml` | Exact-HEAD CI: 0027 SQL on PG 16 and 17 (with and without the ledger) and the end-to-end job. |

## Security model

* **No browser-held secret.** The browser has an HttpOnly sealed cookie and a CSRF token. The access token, database URL, worker credentials and MAC key never reach client code (a static test and the bundle-secret scan enforce it).
* **No direct private access.** The browser cannot reach `editorial_private.*`/`admin_private.*` or the internal functions; the e2e suite asserts 401/403/404 with a real AAL2 token.
* **Server-side authorization on every call.** Cookie → live GoTrue user → `fdb_admin_entry_ready` → the RPC re-runs the evaluator in the same transaction. A revoked session, expired grant or TOTP older than 15 minutes is refused at the next request (tests).
* **Fail closed.** Missing policy, grants or backend configuration produce a denial/unavailable state, never an empty CMS. A lost reply on a write is an *unknown outcome*; retrying reuses the same request id and cannot apply twice.
* **No bypass flag.** Admin is enabled only by the existing predicate (local mode, not hosted, `FOREVERDB_DEPLOYMENT=local`; `HOSTED_ADMIN_AUTH_APPROVED` stays `false`). A static test pins both and forbids any new flag.
* **Safe content.** react-markdown renders elements (no raw HTML), images/embeds are not allowed, links are absolute https only with `rel="noopener noreferrer nofollow ugc"`; the same rules are enforced by the schema and the database.
* **No private draft through public APIs.** Public pages read only the separate public-read projection (ADM-03C overlay); the e2e suite checks drafts, intents and rejected articles are absent from article, archive, RSS and sitemap.

## ADM-03C dependency handling

`web/tests/admin-cms-stack/adm03c.pin` pins PR #206's head commit. `fetch-adm03c.sh` exports exactly: migration 0026, public-read 0013, the one-shot worker and six web files into a
git-ignored directory; `build-site.sh` overlays the web files onto a **copy** of the repository. Nothing of ADM-03C is in this diff. When ADM-03C is merged: delete the pin, the
overlay steps in `up.sh`/`build-site.sh` and the workflow, rebase onto `main`, and re-run the suite before this PR may merge.

## How to open and test the real isolated CMS

You need a throw-away PostgreSQL 16 superuser connection (never a real database), Go, Node 24 and `npm ci` in `web/`. Nothing below contacts Supabase or Vercel.

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=<disposable cluster password>
database/tests/account/build-gotrue.sh "$HOME/stack-bin/gotrue"
# download PostgREST v12.2.12 (linux-static-x86-64), verify sha256 5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5, extract `postgrest` to $HOME/stack-bin
export GOTRUE_BIN=$HOME/stack-bin/gotrue POSTGREST_BIN=$HOME/stack-bin/postgrest
web/tests/admin-cms-stack/fetch-adm03c.sh /tmp/adm03c && export FDB_ADM03C_DIR=/tmp/adm03c
web/tests/admin-cms-stack/up.sh
web/tests/admin-cms-stack/build-site.sh
cd web && node tests/admin-cms-stack/seed-demo.mjs          # prints four demo staff accounts with password and TOTP secret
tests/admin-cms-stack/serve.sh                              # leave running; the site is http://localhost:3220
```

1. Open `http://localhost:3220/account/login`, sign in as the **Editor**. In *Admin authentication* press **Request TOTP challenge** and enter the code from
   `node tests/admin-cms-stack/totp.mjs <TOTP secret>` (it works like an authenticator app). You land in `/admin`.
2. **Articles → New draft**: fill the form, save. Reload: it persists. **Edit** → save: a new revision (r2); the **Revisions** tab shows both and a diff.
3. **Submit for review**. Sign in as the **Second Editor** in a private window (same TOTP steps): **Return** with a note, or **Reject**.
4. Create a **Featured** (highlighted) article, submit it, try **Approve** as the author-capable account: refused (independent approval). Sign in as the **Administrator** and approve.
5. Sign in as the **Owner** and press **Publish**: status is *Publish pending*; the public page `http://localhost:3220/news/<slug>` is still 404.
6. In another terminal run `tests/admin-cms-stack/deliver.sh` (the real worker). Reload: *Published*, the Delivery tab shows `delivered`, and the article is on `/news`, `/news/rss.xml`, `/sitemap.xml`.
7. **Unpublish** (Owner or Administrator), run `deliver.sh` again: the page is 404 (tombstone) and gone from the archive, RSS and sitemap.
8. Owner/Administrator: **Audit Log** shows the events; as the Editor it shows "Not authorized". **Staff & Roles**: every control is disabled.

To stop: Ctrl-C the site, `web/tests/admin-cms-stack/down.sh`. To run the automated acceptance instead: `cd web && npx playwright test -c playwright.admin-cms.config.ts`.

## Remaining functional gaps

* **No staff management.** No API to invite, assign, grant, suspend or revoke; staff are provisioned by test-only SQL here. Staff & Roles stays informational by design.
* **No media upload or registration.** Existing rights-verified asset references are preserved in edits; none can be added from the UI.
* **Delivery is manual in the harness.** The worker is a one-shot process run by the test/operator; no scheduler exists until ADM-03C's activation work.
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
* **Next.js advisory.** The pinned `next@16.4.2` triggers a one-time security advisory notice in `next build`; PR #206 bumps it to 16.4.6. This PR does not change the dependency. The advisory should be handled by the dependency owner before any hosted use.
* **Pre-existing Admin entry bug fixed here** (QR size, above) shows the account-side Admin flow had never run against the real pinned GoTrue in a browser; other untested edges may exist.
* **Roles in the harness are minimal** (Editor, Administrator, Owner, Moderator); lifetime, review-due and emergency-revoke flows of the staff lifecycle are not exercised from the UI.
