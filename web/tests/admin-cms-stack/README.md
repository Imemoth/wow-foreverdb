# Admin CMS end-to-end stack (ADM-04)

A **disposable** stack that runs the real Admin CMS UI against a real backend. It exists only for development and CI. It never touches Supabase, a hosted
database, Vercel or any production credential; every secret in it is a public test constant of a throw-away cluster.

| Component | What it is | Pin |
| --- | --- | --- |
| PostgreSQL | a local/disposable **superuser** cluster (CI: `postgres:16` container) | major 16 |
| Auth | **real GoTrue**, built from source by `database/tests/account/build-gotrue.sh` | `supabase/auth` v2.197.0, commit `4eee58f2…` (the build refuses a moved tag) |
| REST | **real PostgREST** (static release binary) | v12.2.12, sha256 `5de4092f…57d5` |
| Gateway | `web/tests/auth-stack/stack-server.mjs` (stands in for Kong: `/auth/v1`, `/rest/v1`) | — |
| Private database `fdb_account_it` | migrations 0001–0012, 0018, **0020–0025** (Admin + ADM-03B CMS), **0026** (ADM-03C delivery ledger), **0027** (ADM-04 reads) — all native in this repository | — |
| Public-read database `cms_public_it` | public-read migrations 0001, 0002, 0008 and **0013** (ADM-03C projection) | — |
| Worker | the real ADM-03C one-shot dispatcher `cms-delivery/src/once.mjs`, a separate process with its own database roles | repository |
| Website | a production build of **this checkout** (including the native ADM-03C public adapter), in place | `build-site.sh` |

## ADM-03C is part of the repository

ADM-03C (PR #206) is merged: the delivery ledger (migration 0026), the public projection (public-read 0013), the one-shot worker and the website's public adapter are used directly from the checkout. There is no pinned fetch, no overlay and no copy. The inactive-boundary behaviour (no ledger, every intent *blocked*) stays covered by the SQL suite `database/tests/admin_cms_reads/run.sh` without `FDB_ADMIN_WITH_DELIVERY=1`.

## Run it (needs: PostgreSQL 16 superuser connection to a THROW-AWAY cluster, Go, Node 24, `npm ci` in `web/`)

```bash
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=...      # a disposable cluster; up.sh refuses a non-loopback host
database/tests/account/build-gotrue.sh /path/to/gotrue                    # real GoTrue at the pinned commit
# PostgREST: download the pinned release, verify its sha256, extract `postgrest`
export GOTRUE_BIN=/path/to/gotrue POSTGREST_BIN=/path/to/postgrest
npm ci --prefix cms-delivery --ignore-scripts                              # the worker dependency (or build-site.sh links web/node_modules)
web/tests/admin-cms-stack/up.sh            # databases, migrations, GoTrue, PostgREST; drops the disposable databases/roles of earlier runs
web/tests/admin-cms-stack/build-site.sh    # production build of this checkout, with the stack coordinates
cd web && npx playwright test -c playwright.admin-cms.config.ts            # browser acceptance (starts the site on :3220 itself)
web/tests/admin-cms-stack/down.sh
```

Ports: 9999 (GoTrue), 54321 (gateway), 54323/54327 (PostgREST), 54326 (gateway template listener), 3220 (website). The e2e stack of the account suite uses the
same GoTrue port and database name: do not run both at once. `up.sh` also drops `fdb_admin_it*`, because the SQL suites share the cluster-level `admin_executor` role.

## Manual testing by the Product Owner

See [docs/admin/adm-04-real-admin-cms-ui.md](../../../docs/admin/adm-04-real-admin-cms-ui.md#how-to-open-and-test-the-real-isolated-cms). In short: `up.sh`, `build-site.sh`,
`node tests/admin-cms-stack/seed-demo.mjs` (demo staff with real TOTP), `serve.sh`, open `http://localhost:3220/account/login`; after pressing Publish/Unpublish run `deliver.sh`.

## What this proves, and what it does not

Proves: the browser UI, the server-only adapter, real GoTrue sessions/TOTP, real PostgREST JWT verification, the ADM-01B evaluator, the ADM-03B contract, the ADM-04 reads,
the native ADM-03C ledger/worker/projection and the public pages interoperate, with genuine persistence and permissions. Does **not** prove: hosted Supabase (Kong, new-style keys,
managed Auth settings), hosted PostgREST/pooling, CDN behaviour, or the cross-database exposure window measured in a target-configured staging environment.
