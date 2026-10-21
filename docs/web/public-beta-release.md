# AzerDex public beta on real published data (P2-Z3)

`https://beta.azerdex.com` (Vercel project `wow-foreverdb`, branch `web/azerdex-beta`) reads the genuine, sanitized, published
ForeverDB observations from the public Supabase project `azerdex-public-read` (`chcoypkjzxfznsqmmbrq`). It never serves the synthetic
fixture and never falls back to it.

```
Companion → private Supabase (wow-forever) ─(foreverdb_projection_reader, EXECUTE on publication_export.*)→
  Edge Function publish-observations ← pg_cron */15 ← Vault ─→ public Supabase (azerdex-public-read, pub.* + web_api.*)
  → foreverdb_web_reader via Supavisor (aws-0-eu-west-1.pooler.supabase.com:6543, TLS verified) → Next.js on Vercel → Leaflet
  map artwork: https://azerdex-assets.pages.dev (Cloudflare Pages)
```

## What the integration PR contains

Branch `p2z3/beta-real-data-integration` = `web/azerdex-beta` + a merge of the PR #84 chain (#70 → #72 → #77 → #78 → #84):
map engine, atlas importer, unified zone atlas, Supabase-native publisher, map-point APIs. The merge was conflict-free; no beta branding,
copy, navigation or SEO file was overwritten. The chain contains no account, Companion or administrative features. The original
stacked Draft PRs are untouched.

Beta-specific changes on top (this branch only):

| Area | Change |
| --- | --- |
| SEO (`web/src/lib/seo.ts`) | Beta homepage is indexable only when **all** hold: host `beta.azerdex.com`, path `/`, `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=postgres`, branch equals `BETA_SEO_AUTHORIZED_BRANCH`, **and** the database answers with a genuine active publication (`hasGenuinePublication`: dataset `published` + publication id + publication time). Any database failure ⇒ noindex. Applied to the HTML meta, `X-Robots-Tag` (proxy), JSON-LD, `robots.txt` and `sitemap.xml` |
| Fail closed | `data()` has no fixture fallback: with `postgres` it serves PostgreSQL or an error (pages: generic error page; API: `503 temporarily_unavailable`, sanitized log line). Unchanged and verified by `beta-seo.spec.ts` |
| Copy | Homepage, `/download`, FAQ, `/about/data` no longer claim synthetic data; `/about/data#maps` and the footer now state that zone map images come from the game client, remain Blizzard's property, AzerDex claims no rights and use is subject to review. Calibration is stated as provisional |
| Tests | Unit tests for the policy; real-HTTP e2e (`beta-seo.spec.ts`) incl. a published read model in CI; CI step added to `publisher-and-pipeline` |

## Public database reader (verified 2026-10-21)

- `foreverdb_web_reader`: now `LOGIN`, `CONNECTION LIMIT 20`, `statement_timeout=3s`, `idle_in_transaction_session_timeout=5s`,
  `default_transaction_read_only=on`, no superuser/createdb/createrole/replication/bypassrls, no role memberships.
- Privileges (checked with `has_*_privilege` and by actually running statements as the role): EXECUTE on 11 of 13 `web_api` functions
  (the two internal helpers are not granted); `0` on `pub_admin`/`pub_ops`; no usage on `pub`, `vault`, `cron`; no write privilege on any
  application table; cannot create objects; `select pub.sources`, `delete pub.sources`, `activate_publication`, `begin_publication`,
  `set_schedule`, `vault.decrypted_secrets`, `create table` are all **denied**. Real data through the role: `zone_map_points(1420)` = 138 cells,
  `(1420,'mining')` = 28, `source_map_points('gameobject',1731,1420)` = 23.
- No access to the private `wow-forever` project is possible: separate project, separate credentials, and `env.ts` rejects any URL that references its ref.
- **Residual platform default (cannot be revoked by the project):** Supabase-owned `pg_net` objects (`net.http_post`, `net.http_request_queue`,
  `net._http_response`) carry `PUBLIC` grants, so any login role, including the reader, technically has them. The website only runs fixed,
  parameterized `web_api.*` statements (no ad-hoc SQL path), so this is not reachable from the site; revocation attempts were no-ops
  (objects are owned by `supabase_admin`). Mitigation if ever needed: Supabase Network Restrictions.
- Credential: generated inside the database; stored **only** in the public project's Vault as `web_reader_password_<timestamp>`
  (owner-readable) and, once set, in Vercel as a *sensitive* variable. Rotate: `alter role foreverdb_web_reader password '<new>'`, store the new
  one in Vault, update Vercel, redeploy.
- **Pooler (verified, not assumed):** `aws-0-eu-west-1.pooler.supabase.com`, port `6543` (transaction mode), SCRAM auth, user
  `foreverdb_web_reader.chcoypkjzxfznsqmmbrq`. `aws-1-eu-west-1` answers *tenant/user not found* for this project. A login from inside
  Supabase's network through that pooler succeeded with TLS certificate verification **on** (default roots, `rejectUnauthorized: true`),
  with and without the `statement_timeout`/`application_name` startup parameters the web adapter sends. The sandbox itself cannot reach the pooler,
  so the Node/Vercel side of this connection is verified by the post-deployment checks below.
- Pool settings in `postgres-adapter.ts`: max 5 per instance, 3 s connect, 3 s statement, 4 s query timeouts, `ssl.rejectUnauthorized=true`
  (no `sslmode` in the URL, which would override it).

## Effective beta configuration (branch-scoped to `web/azerdex-beta`, target Preview)

| Variable | Value | Secret | Status |
| --- | --- | --- | --- |
| `AZERDEX_ZONE_MAPS` | `1` | no | already set (per owner) |
| `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` | `https://azerdex-assets.pages.dev` | no | already set (per owner) |
| `FOREVERDB_DEPLOYMENT` | `preview` | no | **owner action** (was `preview` already; confirm) |
| `FOREVERDB_DATA_SOURCE` | `postgres` (currently `fixture`) | no | **owner action** |
| `AZERDEX_READ_DB_URL` | `postgresql://foreverdb_web_reader.chcoypkjzxfznsqmmbrq:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres` | **yes, mark Sensitive** | **owner action** |
| `BETA_SEO_AUTHORIZED_BRANCH` | `web/azerdex-beta` | no | already set earlier (confirm it still exists) |
| `RATE_LIMIT_BACKEND`, Upstash REST vars, `RATE_LIMIT_SALT` | as configured 2026-10-20 | yes | confirm unchanged |

**Naming:** the connection string variable is `AZERDEX_READ_DB_URL` (formerly `PUBLIC_READ_DATABASE_URL`). Vercel classifies the `PUBLIC_` prefix as public and refuses to store it as a Secret/Sensitive value; the new name is server-only, is never `NEXT_PUBLIC_*`, is still scanned for the private project reference at startup, and the old name is ignored (the site then fails closed).

The Vercel connector available to the authoring session returns HTTP 403 on both reading and writing project environment variables and the
sandbox has no Vercel CLI credentials, so the three variables above could **not** be set by the authoring session. Do not touch the shared
Preview defaults, Production, `azerdex.com` or other branches: create each variable with "Preview → Specific branch → `web/azerdex-beta`".

```
# password for the URL (Supabase SQL editor on azerdex-public-read, owner only):
select decrypted_secret from vault.decrypted_secrets where name like 'web_reader_password_%' order by created_at desc limit 1;
# or, from a terminal with the Vercel CLI, paste via stdin so it never lands in shell history:
vercel env add AZERDEX_READ_DB_URL preview web/azerdex-beta --sensitive
vercel env add FOREVERDB_DATA_SOURCE preview web/azerdex-beta          # postgres
vercel env add FOREVERDB_DEPLOYMENT preview web/azerdex-beta           # preview
```

## Release sequence (one approval)

1. Owner sets the three variables above (branch-scoped).
2. Owner approves/merges the integration PR into `web/azerdex-beta` (all required checks green; branch protection untouched).
3. Vercel builds the branch; confirm the deployment's `gitSource.sha` equals the merge commit and that the **custom domain** serves it
   (a Preview of the PR is **not** a deployment of `beta.azerdex.com`).
4. Run the live verification below.

If step 1 is skipped the merged site fails closed: `FOREVERDB_DATA_SOURCE=fixture` on the beta host keeps the homepage `noindex` (policy requires `postgres`).

## Live verification checklist (anonymous browser, `https://beta.azerdex.com`)

- `/api/v1/meta` → `mode: "published"`, `publicationId` equals `select active_publication_id from pub.state` on the public DB.
- `/api/v1/zones/1420/map-points`, `?kind=mining`, `/api/v1/sources/gameobject/1731/map-points?zone=1420` → `dataset: "published"`, same `publicationId`;
  Copper Vein points are a subset of the zone's mining/gameobject cells.
- `/` meta robots `index, follow`, no `X-Robots-Tag`, canonical and `og:url` = `https://beta.azerdex.com`; every other path `noindex, nofollow`; `*.vercel.app` alias `noindex`.
- `/robots.txt` allows `/`, disallows `/api/` and `/verify`, lists the sitemap; `/sitemap.xml` has exactly the homepage.
- `/zones` lists all atlas zones and cities; `/zone/1420`, `/zone/1412`, `/zone/1421` show Cloudflare artwork with markers, clustering, filters
  (Mining on 1420), links to sources; `/object/1731` shows the Copper Vein points; an unobserved zone (e.g. `/zone/1458` if empty) says
  "No public observations are available for this zone yet" and still shows its map.
- No `synthetic` wording on the pages or banner; DevTools network tab: only the CDN origin and same-origin calls, no database host, no credential in HTML/JS.
- Simulate an outage (temporarily wrong password in a throwaway Preview, never on the beta): pages show the error page, APIs return `503`, homepage is `noindex`, no fixture content.

## Calibration

Markers use the game's own normalized map coordinates and a 1 % grid with a two-observation floor. Calibration stays **`provisional`**:
the artwork loading does not prove geographic registration. Verification needs an owner-browser comparison of independently identifiable landmarks
(e.g. Brill and Deathknell in Tirisfal Glades against known coordinates) on `/zone/1420`; record the result before changing any manifest status.

## Operations

Scheduling, monitoring, pause/resume and rollback of the publication pipeline: [public-publication-operations.md](public-publication-operations.md).
Measured limits (2 s Edge CPU limit reached at roughly 25–27× the measured baseline volume; current volume uses about 8 %) and verdict: [public-publication-benchmarks.md](public-publication-benchmarks.md).

## Rollback

| Layer | Action |
| --- | --- |
| Website | Vercel → Deployments → previous deployment of `web/azerdex-beta` → *Promote/Instant rollback* (or revert the merge commit). Env changes: set `FOREVERDB_DATA_SOURCE` back to `fixture` to return to the previous synthetic beta |
| Data | `select pub_ops.set_schedule(false);` then, as `foreverdb_pub_owner`, `select pub_admin.activate_publication(<previous id>)` (last 3 publications retained) |
| Reader | `alter role foreverdb_web_reader nologin;` (site then fails closed with 503s and a noindex homepage) |
| Indexing | Unset `BETA_SEO_AUTHORIZED_BRANCH` on the beta branch: the homepage becomes `noindex` immediately |
