# Map atlas CDN — preflight, approval steps and rollback

Status: **prepared, NOT deployed.** Nothing in this repository uploads to Cloudflare, changes DNS, touches Vercel environment variables or promotes the version ledger.
The package is built by `atlas.py import-exporter` (see [`map-atlas.md`](map-atlas.md)) from the owner's verified real export and lives **outside Git** (`atlas-dist-<version>.zip`).

## What gets published
A single complete Direct Upload snapshot for the existing Cloudflare Pages project `azerdex-assets` (hostname `azerdex-assets.pages.dev`; later `assets.azerdex.com`):

```
_headers   atlas/{index,hierarchy,builds,instances}.json   forever/{uiMapID}/{vN}/{manifest.json,base.webp,full-reveal.webp,…}
```
Every `(uiMapID, vN)` is immutable. Pages Direct Upload deploys a *whole snapshot*, so every build starts from the previous snapshot (`--previous-dist`) and carries every published version forward byte-for-byte; the build fails if any published file is missing or changed.

## Preflight checklist (all must be ticked before asking for approval)
Automated by `import-exporter` (reported in `reports/coverage.md`; the command exits non-zero if any fails):
- [ ] Source ZIP intact; no unsafe paths, symlinks or duplicate/conflicting entries; SHA-256 recorded (and pinned with `--expect-zip-sha256`)
- [ ] Complete, unfiltered export (`COMPLETE`, UiMap rows == maps, zero failures) with the expected counts (`--expect-maps/--expect-variants/--expect-instances`)
- [ ] One exact client build (`product`, `version`, `buildKey`) across build/index/manifests
- [ ] Every image: bytes, SHA-256, WebP decode and dimensions; base ≠ full-reveal
- [ ] Manifests satisfy the web manifest contract
- [ ] dist ⊇ ledger (nothing published is missing/changed); `forever/1420/v1` (POC) byte-identical
- [ ] Pages Free limits: ≤ 20,000 files, ≤ 25 MiB per file, CDN path convention only; no diagnostics/local paths published
- [ ] Ledger **not** promoted

Manual (owner):
- [ ] Open `preview/index.html`: every map looks right; read `reports/coverage.md`, `instance-catalog.md`, `tirisfal-regression.md`
- [ ] Accept the known caveats (below)
- [ ] `SHA256SUMS.txt` / `dist-files.json` kept with the ZIP as the audit record
- [ ] Note the *current* Pages production deployment ID (rollback target) and keep the previous dist archive

## Owner approval steps (each is a separate decision)
1. **Approve the upload.** From the folder that contains `dist/`:
   `npx wrangler pages deploy dist --project-name azerdex-assets --branch <the project's production branch>` (Direct Upload; check the production branch name in the Pages dashboard). Do not create a new project, change the custom domain or edit DNS as part of this step.
2. **Verify what is actually served** (read-only):
   `python scripts/map-atlas/atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist <out>/dist`
   It downloads every file, compares SHA-256 with the audited distribution and checks `Cache-Control` and `Access-Control-Allow-Origin`; it also confirms an unknown path returns 404 (no catch-all fallback masking misses).
3. **Promote the ledger** only after step 2 passes: `python scripts/map-atlas/atlas.py promote-ledger --from <out>/ledger.next.json` and commit `scripts/map-atlas/ledger/published.json` (append-only; refuses any change/removal).
4. **Enable the website to read it** (separate approval; preview first): set `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev` on the Vercel *Preview* environment only, redeploy, and open `/poc/maps/tirisfal?version=v2`. The value is validated against an allow-list (`azerdex-assets.pages.dev`, `assets.azerdex.com`; https, no port/path/credentials) and widens only `img-src`/`connect-src` of `/poc/maps/*`. Unset the variable and the POC falls back to its same-origin `/maps` assets.
5. `assets.azerdex.com` (custom domain/DNS), production env vars and any live-page integration are **separate** later decisions.

## Rollback plan
- **Nothing was promoted before verification**, so a failed or doubtful upload needs no repository change: do not run `promote-ledger`.
- **Bad snapshot:** Cloudflare Pages keeps earlier deployments; roll the project back to the deployment ID noted in the preflight (Pages dashboard → Deployments → previous deployment → rollback; confirm the exact control in the dashboard). Then re-run `verify-remote` against the previous audited dist.
- **Bad asset in a published version:** never edit in place (files are immutable and cached for a year). Fix the source, re-import: the changed asset set gets the **next** version (`vN+1`) and the mutable `atlas/*.json` (5-minute cache) point to it; the old version stays available.
- **Ledger already promoted but the deployment rolled back:** keep the archived previous dist; the next build needs `--previous-dist` to carry the recorded versions forward, otherwise it refuses (by design).
- **Website:** unset `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` and redeploy (or use Vercel's instant rollback) — the POC returns to same-origin assets. No data or schema is involved.

## Headers (`_headers`) vs. the real consumers
| Path | Policy | Why |
| --- | --- | --- |
| `/forever/*` | `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `nosniff` | versioned, immutable images and manifests; the viewer `fetch`es the manifest cross-origin (credentials `same-origin`, so nothing is ever sent), the `<img>` needs no CORS |
| `/atlas/*` | `Cache-Control: public, max-age=300, must-revalidate`, same CORS | mutable indexes: short cache + revalidation |

`atlas-cdn.spec.ts` (local acceptance) proves these against a real HTTPS server on the allow-listed host name under the site's CSP, including that **removing the CORS header makes the browser block the manifest**.

## Known caveats and limitations
- Calibration is `provisional` for every map; image dimensions matching the POC prove nothing about landmark registration.
- Licensing status is recorded as `unreviewed` in every manifest (factual provenance); the noncommercial POC approach is the owner's recorded decision. The distribution is game artwork: keep the ZIP/gallery private until publication is approved.
- The exporter's report counts 60 maps as *reused* from an earlier run; the importer re-verified every image independently (hash, size, WebP decode) and does not rely on that report.
- One full-reveal (Stranglethorn Vale) is `tileless-declared-overlays-skipped`: overlays the client declares have no tile records, so no art exists for them. It is still the default (verified against the reviewed atlas) and is flagged in its manifest, the gallery and the report.
- Several maps share a slug (`kalimdor`, `eastern-kingdoms`, `zephras-isle`): always address maps by `uiMapId`.
- The instance catalog is raw and unreviewed: it includes development/test records (flagged by transparent heuristics, not removed) and cannot say which instances are released. 51 of 55 have no interior map art and none is invented. Floors/entrances stay unverified.
- City maps carry exporter category `city` from a small English name list (confidence recorded per map).
- No tiled representation: each variant is one WebP (largest 293 KB), far under the Pages limits.
