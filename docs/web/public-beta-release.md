# AzerDex public beta on real published data (P2-Z3) — CLOSED

**Status: `P2-Z3 COMPLETE` (2026-10-21).** `https://beta.azerdex.com` (Vercel project `wow-foreverdb`, branch `web/azerdex-beta`) serves the
genuine, sanitized, published ForeverDB observations from the public Supabase project `azerdex-public-read` (`chcoypkjzxfznsqmmbrq`). It
never serves the synthetic fixture and never falls back to it. Remaining non-blocking items are listed at the end.

```
Companion → private Supabase (wow-forever) ─(foreverdb_projection_reader, EXECUTE on publication_export.*)→
  Edge Function publish-observations ← pg_cron */15 ← Vault ─→ public Supabase (azerdex-public-read, pub.* + web_api.*)
  → foreverdb_web_reader via Supavisor (aws-0-eu-west-1.pooler.supabase.com:6543, TLS verified) → Next.js on Vercel → Leaflet
  map artwork: https://azerdex-assets.pages.dev (Cloudflare Pages)
```

## Final deployment status

| | |
| --- | --- |
| Beta branch head | `c2f9dafc64d6e70a81c79cc4d7f7dbd7816032a1` (merge of #89) |
| Serving deployment | `dpl_5Kx7MaShB58wWF8vGfnninnaPvNq`, READY, commit `c2f9daf`, aliases `beta.azerdex.com` and the `web-azerdex-beta` branch alias (an earlier manual deployment `dpl_7CVjKiWRAwpQJW5vaMybi1J8LmXU` of the same commit also exists, see the auto-deployment anomaly below) |
| Dataset | `/api/v1/meta` → `mode: "published"`; publication id advances on its own (10 → 11 → 12 → 13 observed on 2026-10-21 through scheduled runs) |
| Cron | `*/15 * * * *`, consecutive ticks `succeeded`, 0 failed runs; unchanged content is `duplicate` with zero writes |
| Owner acceptance | Map artwork, markers and Next.js soft navigation manually verified in a browser on `beta.azerdex.com` by the owner (2026-10-21) |

### PRs

| PR | Content | State |
| --- | --- | --- |
| #85 | Integration of the #70 → #84 chain into `web/azerdex-beta`, published-data SEO policy, truthful copy, `AZERDEX_READ_DB_URL` rename | merged |
| #86 | Sanitized database error diagnostics (fixed vocabulary, no driver text) | merged (`8768e93`) |
| #87 | TLS root-cause fix: trust the Supabase Root 2021 CA for pooler hosts only | merged (`4951af6`) |
| #89 | CSP fix: atlas CDN origin on every HTML document so Next.js soft navigation keeps working | merged (`c2f9daf`) |
| #70, #72, #77, #78, #84 | The stacked development chain, integrated into the beta through #85; the original Draft PRs are intentionally left open and untouched | open (Draft) |
| #88 | Account-scoped Guildbook (Companion/accounts). **Not part of the beta recovery** and untouched | open |

## Root causes found during recovery (evidence-based)

1. **TLS — `SELF_SIGNED_CERT_IN_CHAIN`.** After #85 the beta returned 503/500 on every data call. The sanitized log from #86 showed
   `category: tls_verification, code: SELF_SIGNED_CERT_IN_CHAIN` with a correct target shape (pooler host, port 6543, project-qualified reader
   user, no `sslmode`). The Supavisor chain ends in the private **Supabase Root 2021 CA**, which Node's built-in trust store does not contain
   (Supabase's Deno runtime accepted it, which is why an in-Supabase probe had passed). Fix (#87): `ca = [Node roots, Supabase Root 2021 CA]`
   **only** for hosts matching `aws-<n>-<region>.pooler.supabase.com`; every other remote database keeps Node's default store;
   `rejectUnauthorized: true` and host-name verification stay on everywhere. The CA is a public certificate from Supabase's official download
   (valid to 2031-04-26, SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, pinned by a
   unit test). Evidence: from inside Supabase's network the pooler chain validated against that CA alone and a corrupted CA failed; a local
   Node + `pg` reproduction gave the same error with default roots, success with the CA, and `ERR_TLS_CERT_ALTNAME_INVALID` for a wrong host.
   **If Supabase ever rotates its pooler root, the symptom will be the same error; replace `web/src/lib/data/supabase-ca.ts` (and its pinned test).**
2. **CSP vs Next.js soft navigation.** A Content-Security-Policy belongs to the *document*; client-side navigation keeps the policy of the page
   first loaded. The atlas CDN origin was added only to the map routes, so landing on `/`, `/zones`, `/database` … and clicking through to a map
   made the browser block the Cloudflare manifest/images (`connect-src 'self' https://challenges.cloudflare.com`) until a hard reload. Fix (#89):
   `assetOriginForPage()` adds the **validated** origin (allow-list, https only, no wildcard/port/userinfo) to `img-src` and `connect-src` of every
   HTML document while `AZERDEX_ZONE_MAPS=1`. `script-src`/`style-src` (nonce, no `unsafe-inline`), `default-src` and everything else are
   unchanged; with the gate off (Production today) the policy is byte-for-byte as before.
3. **Variable naming.** Vercel refuses to store a `PUBLIC_`-prefixed variable as a Secret, so the connection string is `AZERDEX_READ_DB_URL`
   (formerly `PUBLIC_READ_DATABASE_URL`); server-only, Sensitive, never `NEXT_PUBLIC_*`, still scanned for the private project reference, the old name
   is ignored (fails closed).

## Test evidence

- Unit: 643 tests (policy, SEO, TLS options and CA pinning, error diagnostics, CSP origin matrix).
- Real-HTTP e2e `beta-seo.spec.ts` against a published read model in CI (host/branch/path/publication conditions, fixture and unreachable-database
  cases fail closed to `noindex`).
- Browser regression `tests/zone-maps/soft-navigation.spec.ts` (desktop + mobile, real local HTTPS CDN on the allow-listed host so Chromium enforces
  CSP and CORS): `/` → Zones → Tirisfal map → Copper Vein → its zone map → Zones → Silverpine map → Tin Vein → its zone map with no document
  reload; at every step manifest and WebP load with HTTP 200 (first visit), the image decodes, markers draw, no fallback, no blocked request, no CSP
  error. It failed on the unfixed code and passes after #89. The whole zone-maps suite: 70 passed, 2 skipped (real-art only).
- Live (via the deployment tooling, 2026-10-21): `/api/v1/meta` published; `/api/v1/zones/1420/map-points` = 138 cells, `?kind=mining` = 28,
  `/api/v1/sources/gameobject/1731/map-points?zone=1420` = 23 (a subset of the zone's mining cells), all `dataset: "published"` with the same
  publication id; `/zone/1420|1412|1421` carry 138 / 10 / 9 cells matching the database; `/`, `/zones`, `/zone/*`, `/object/1731`, `/database` answer 200
  without database errors and without "synthetic" wording; homepage `index, follow` with canonical/`og:url`/JSON-LD = `https://beta.azerdex.com` and
  no `X-Robots-Tag`, every other page `noindex, nofollow`, `*.vercel.app` alias `Disallow: /` + `noindex`; `robots.txt` allows `/` and lists the
  sitemap, `sitemap.xml` has exactly the homepage; live CSP of `/` and `/database` contains the CDN origin only in `img-src`/`connect-src`.
- Owner browser acceptance of artwork, markers and soft navigation on the live beta (see above). The sandbox cannot reach the beta domain
  anonymously or the CDN, so a live in-browser run by the authoring session was not possible.

## Public database reader (verified 2026-10-21)

- `foreverdb_web_reader`: `LOGIN`, `CONNECTION LIMIT 20`, `statement_timeout=3s`, `idle_in_transaction_session_timeout=5s`,
  `default_transaction_read_only=on`, no superuser/createdb/createrole/replication/bypassrls, no role memberships.
- Privileges (checked with `has_*_privilege` and by running statements as the role): EXECUTE on 11 of 13 `web_api` functions (the two internal
  helpers are not granted); nothing on `pub_admin`/`pub_ops`; no usage on `pub`, `vault`, `cron`; no write privilege on any application table; cannot
  create objects; `select pub.sources`, `delete pub.sources`, `activate_publication`, `begin_publication`, `set_schedule`,
  `vault.decrypted_secrets`, `create table` are all **denied**.
- No access to the private `wow-forever` project is possible: separate project and credentials, and `env.ts` rejects any URL that references its ref.
- **Residual platform default (cannot be revoked by the project):** Supabase-owned `pg_net` objects carry `PUBLIC` grants, so any login role, including
  the reader, technically has them. The website only runs fixed, parameterized `web_api.*` statements (no ad-hoc SQL path); revocation attempts were
  no-ops (objects are owned by `supabase_admin`). Mitigation if ever needed: Supabase Network Restrictions.
- Credential: generated inside the database, stored in the public project's Vault as `web_reader_password_<timestamp>` and in Vercel as a *Sensitive*
  variable. Rotate: `alter role foreverdb_web_reader password '<new>'`, store it in Vault, update Vercel, redeploy.
- Pooler: `aws-0-eu-west-1.pooler.supabase.com:6543` (transaction mode, SCRAM). `aws-1-eu-west-1` answers *tenant/user not found* for this project.
- Pool settings (`postgres-adapter.ts`): max 5 per instance, 3 s connect, 3 s statement, 4 s query timeouts, TLS verification on (see root cause 1;
  no `sslmode` in the URL, which would override it). Failed calls log a sanitized error class only (`public_db_error`: category, code, `web_api`
  function, non-secret URL shape), never driver text or credentials.
- Migration history of the public project was reconciled: 0004–0006 recorded in the ledger (objects were applied through `execute_sql`; 29 function
  definitions are md5-identical to the repo); nothing was re-applied.

## Effective beta configuration (Vercel, Preview, branch `web/azerdex-beta` only)

| Variable | Value | Secret |
| --- | --- | --- |
| `AZERDEX_ZONE_MAPS` | `1` | no |
| `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` | `https://azerdex-assets.pages.dev` | no |
| `FOREVERDB_DEPLOYMENT` | `preview` | no |
| `FOREVERDB_DATA_SOURCE` | `postgres` | no |
| `AZERDEX_READ_DB_URL` | `postgresql://foreverdb_web_reader.chcoypkjzxfznsqmmbrq:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres` | **yes (Sensitive)** |
| `BETA_SEO_AUTHORIZED_BRANCH` | `web/azerdex-beta` | no |
| `RATE_LIMIT_BACKEND`, Upstash REST vars, `RATE_LIMIT_SALT` | as configured 2026-10-20 | yes |

The authoring tooling could not read or write Vercel environment variables (HTTP 403), so these were set by the owner; Production, `azerdex.com`, DNS,
Cloudflare and other Preview branches are untouched.

## SEO policy (beta homepage only)

`/` is indexable only when all hold: host `beta.azerdex.com`, path `/`, `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=postgres`, branch equals
`BETA_SEO_AUTHORIZED_BRANCH`, and the database answers with a genuine active publication (`hasGenuinePublication`, checked per request). Any database
failure ⇒ `noindex`. Applied to the HTML meta, `X-Robots-Tag` (proxy), JSON-LD, `robots.txt` and `sitemap.xml`. Every other page, every `*.vercel.app`
alias and every other branch stays `noindex`. Technical eligibility is the acceptance criterion; actual indexing is up to search engines.

## Remaining limitations (non-blocking)

1. **Map calibration stays `provisional`.** Markers use the game's normalized map coordinates, a 1 % grid and a two-observation floor. Artwork
   loading does not prove geographic registration; verification needs an owner comparison of independently identifiable landmarks (e.g. Brill and
   Deathknell in Tirisfal Glades) on `/zone/1420`, recorded before any manifest status changes.
2. **Artwork licensing review is pending.** Zone map images come from the game client (Blizzard property) and are served from `azerdex-assets.pages.dev`.
   `/about/data#maps` and the footer state this and that AzerDex claims no rights; the legal decision remains an owner item (see also P2-D).
3. **Vercel Git auto-deployment anomaly.** After #89 was merged (16:13:04 UTC) the Git integration created no deployment for `c2f9daf` for several
   minutes (earlier merges deployed within seconds). A deployment was created manually from the same ref and SHA at ~16:20 UTC; a Git-sourced deployment of
   the same commit (`dpl_5Kx7…`, created ~16:22 UTC by the owner account) then took over the aliases. Cause not established. If it recurs, check the
   Vercel project's Git connection / webhook deliveries and confirm after every beta merge that the deployment SHA equals the merge commit and the domain
   serves it.
4. Publication scaling: the Edge function's 2 s CPU limit is reached at roughly 25–27× the measured volume (current use ≈ 8 %); see
   [public-publication-benchmarks.md](public-publication-benchmarks.md).
5. Housekeeping: the retired Edge function `diag-db-host` (inert, HTTP 410) can only be deleted in the Supabase dashboard; disabling the public
   project's Data API is also a dashboard-only action; the stacked Draft PRs #70/#72/#77/#78/#84 remain open by design.

## Operations

Scheduling, monitoring, pause/resume and rollback of the publication pipeline: [public-publication-operations.md](public-publication-operations.md).

## Live verification checklist (repeatable, anonymous browser, `https://beta.azerdex.com`)

- `/api/v1/meta` → `mode: "published"`, `publicationId` equals `select active_publication_id from pub.state` on the public DB.
- `/api/v1/zones/1420/map-points`, `?kind=mining`, `/api/v1/sources/gameobject/1731/map-points?zone=1420` → `dataset: "published"`, same publication
  id. (`zone=` on the zone endpoint, `map=` on the source endpoint, or any parameter on `/meta` returns a deliberate `400 unknown_parameter`.)
- Home → Zones → a zone map → a source → its zone map **without reloading**: DevTools shows the manifest and WebP from `azerdex-assets.pages.dev` with
  200 and no CSP error.
- SEO: homepage `index, follow`, canonical and `og:url` = `https://beta.azerdex.com`; every other path and the `*.vercel.app` alias `noindex`.
- No `synthetic` wording; no database host or credential in HTML/JS.

## Rollback

| Layer | Action |
| --- | --- |
| Website | Vercel → Deployments → previous deployment of `web/azerdex-beta` → *Instant rollback* (or revert the merge commit). Setting `FOREVERDB_DATA_SOURCE=fixture` returns to the former synthetic beta |
| Data | `select pub_ops.set_schedule(false);` then, as `foreverdb_pub_owner`, `select pub_admin.activate_publication(<previous id>)` (last 3 publications retained) |
| Reader | `alter role foreverdb_web_reader nologin;` (site then fails closed with 503s and a `noindex` homepage) |
| Indexing | Unset `BETA_SEO_AUTHORIZED_BRANCH` on the beta branch: the homepage becomes `noindex` immediately |
