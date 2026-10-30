# Map atlas CDN — preflight, approval steps and rollback

Status: **prepared, NOT deployed.** The atlas-only snapshot below is superseded for the next upload by the **unified snapshot** (atlas + cinematic zone heroes, [`unified-cdn-v2a.md`](unified-cdn-v2a.md)); its upload and rollback steps are in the last section of this page. Nothing in this repository uploads to Cloudflare, changes DNS, touches Vercel environment variables or promotes the version ledger.
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

## Unified snapshot (V2-A: atlas + cinematic zone heroes) — upload and rollback

> **V2-B update:** the executable, Windows-first procedure (read-only PowerShell verification `scripts/map-atlas/windows/Verify-AzerdexCdn.ps1`, optional preview deployment, rollback-target capture, Vercel beta activation smoke tests) is [`v2b-cloudflare-cdn-pilot.md`](v2b-cloudflare-cdn-pilot.md) and supersedes the steps below where they differ.

Pages Direct Upload is a **complete snapshot**: whatever is not in the uploaded folder disappears from the newest deployment. The next upload therefore MUST be the unified dist
(`azerdex-cdn-dist-<build>-<rev>.zip` → `dist/`: the 172 approved atlas files byte-for-byte **plus** the eight `zone-heroes/` files and the extended `_headers`). Never upload a hero-only folder.
Nothing below has been run; every step is a separate owner decision. The agent that prepared this did not and will not upload.

### 0. Before approving (no network writes)
1. Rebuild locally and compare with the reviewed report (the build is deterministic: same inputs ⇒ the same zip sha256):
   `python scripts/map-atlas/atlas.py build-unified --baseline <atlas-dist-1.60.1.70450.zip> --out <out>` → `unified-report.md` must say `READY_FOR_APPROVED_UPLOAD`, 180 files, and the zip sha256 recorded in the PR.
2. `python scripts/map-atlas/atlas.py verify-unified --dist <out>/dist` → `unified dist OK: 180 files`.
3. **Prove the live CDN still equals the baseline** (this could not be done from the preparation environment: proxy 403 on `*.pages.dev`). From an unrestricted machine, with the baseline extracted to `<baseline-dir>`:
   `python scripts/map-atlas/atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist <baseline-dir>`
   Expected: every one of the 171 served files matches by SHA-256 (the `zone-heroes/...` probes must return 404 because nothing is published there yet). If anything differs, **stop**: the baseline is not what is live and the upload must not proceed until the owner decides which state is authoritative.
4. Note the current production deployment ID in the Pages dashboard (rollback target) and keep the baseline zip.

### 1. Upload (owner)
From the folder that contains `dist/`: `npx wrangler pages deploy dist --project-name azerdex-assets --branch <the project's production branch>` (existing project, no new project/R2/DNS/domain change).
Cost: zero (existing Pages Free project; 180 files of 20,000 allowed; largest file 300 KB of 25 MiB; `_headers` 3 rules of 100).

### 2. Verify what is served (read-only)
`python scripts/map-atlas/atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist <out>/dist`
Checks all 179 served files (SHA-256, `Cache-Control`, `Access-Control-Allow-Origin`; for `zone-heroes/*` also `Content-Type: image/webp`, `nosniff`, `Timing-Allow-Origin`) and that unknown paths (`zone-heroes/9999999/v1/…`, `zone-heroes/1424/v999/…`, `forever/9999999/v1/…`) are HTTP **404**, not a fallback page.
If it fails, do not promote anything; use the rollback below.

### 3. Promote the ledgers (only after step 2 passed)
`python scripts/map-atlas/atlas.py promote-ledger --from <out>/ledger.next.json` (maps: appends the 60 baseline versions to `ledger/published.json`; refuses any change/removal) and
`python scripts/map-atlas/atlas.py promote-hero-ledger --from <out>/zone-heroes-ledger.next.json` (heroes: `ledger/zone-heroes.json`). Commit both. From then on a changed file in `zone-heroes/1424/v1` (or any published version) fails the build: new art ⇒ `v2`.

### 4. Website (separate approval, Preview first)
The site keeps serving the heroes from its own origin until `AZERDEX_ZONE_HERO_SOURCE=cdn` is set (with the existing `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL`). Set it on the Vercel **Preview** environment only, redeploy, open `/zone/1424` and `/zone/1431` (network tab: `zone-heroes/…` HTTP 200 from the CDN host, no CSP error), compare with the performance baseline, and only then consider Production. Not part of V2-A.

### Rollback
| Situation | Action |
| --- | --- |
| Upload verification fails / wrong files served | Pages dashboard → project `azerdex-assets` → Deployments → the previously noted deployment → roll back (confirm the control name in the dashboard). Re-run `verify-remote --dist <baseline-dir>`. Do **not** run either `promote-*` command. |
| Hero artwork wrong after publication | Never edit a published file. Fix the source, add `v2` to `heroes/zone-heroes.json` (+ registry entry), build a new unified snapshot, upload, verify. `v1` stays served. Website: flip `AZERDEX_ZONE_HERO_SOURCE` back (below). |
| Website misbehaves with CDN heroes | Unset `AZERDEX_ZONE_HERO_SOURCE` (or set `local`) and redeploy / use Vercel instant rollback: the same-origin `/zones/hero/*` files (kept in the repository) serve again; no data or schema is involved. |
| Ledgers promoted but the deployment rolled back | Keep the archived baseline and the unified zip; the next build needs the baseline (`--baseline`) so every published version is carried forward, otherwise it refuses by design. |

## Unified snapshot + talent icons (Class Guides) - build and upload

Same rule as above: Pages Direct Upload is a **complete snapshot**, so the talent icons ship **inside** the unified snapshot (baseline atlas + zone heroes + `talent-icons/`), never as an icons-only deployment. `talent-icons/<game build>/<FileDataID>.webp` is a third namespace, independent of `forever/` and `zone-heroes/` (module `scripts/map-atlas/mapatlas/talenticons.py`, tests `scripts/map-atlas/tests/test_talent_icons.py`).

| | |
| --- | --- |
| Inventory (committed, ids + sha256 only) | `web/src/data/talents/forever/1.60.1.70634/icons-inventory.json` (358 icons, 64x64 lossless WebP, <= 256 KiB each) |
| Staging directory (**never in Git**) | the owner's converted files laid out as `<dir>/talent-icons/1.60.1.70634/<FileDataID>.webp` (the supplied `AzerDexTalentIcons_CDN_70634.zip` unzipped as is) |
| `_headers` | the reviewed unified rules byte-identical, then `/talent-icons/*` -> `Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff` (no `Content-Type` override: Pages derives `image/webp` from the extension) |
| Checks added | exact file set (baseline pin + heroes + inventory), every icon equals its inventory size and SHA-256 and decodes as a 64x64 WebP, nothing else in the staging directory, atlas metadata may not reference `talent-icons`, Pages limits, per-file response headers; `verify-remote` also holds the icons to type, `nosniff`, immutable cache and a 404 for an unknown icon path |

```bash
cd scripts/map-atlas
# 1. build the COMPLETE snapshot (baseline is verified against its pin first; nothing is uploaded)
python atlas.py build-unified --baseline <atlas-dist-1.60.1.70450.zip> --out <out> \
  --talent-icons-inventory ../../web/src/data/talents/forever/1.60.1.70634/icons-inventory.json --talent-icons-source <staging dir>
python atlas.py verify-unified --dist <out>/dist --talent-icons-inventory ../../web/src/data/talents/forever/1.60.1.70634/icons-inventory.json
# 2. note the current production deployment id (rollback target), then upload the whole folder to the EXISTING project
cd <out> && npx wrangler pages deploy dist --project-name azerdex-assets --branch <the project's production branch>
# 3. verify what is served (read-only): the existing files and the icons
cd scripts/map-atlas && python atlas.py verify-remote --base https://azerdex-assets.pages.dev --dist <out>/dist
node web/scripts/verify-talent-icons-cdn.mjs --dataset web/src/data/talents/forever/1.60.1.70634 --base https://azerdex-assets.pages.dev
```

Expected: `verify-remote` and the icon verifier both pass (358 of 358 icons HTTP 200, `image/webp`, exact hash, immutable cache; unknown icon 404); every previously published file is still served. Then (beta/preview only) set `AZERDEX_TALENT_ICONS=cdn` (the beta already carries `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev` for the maps) and **redeploy** so the new value is read, and open the nine class pages. Rollback: unset `AZERDEX_TALENT_ICONS` (the calculator returns to name plates at once), and roll the Pages project back to the noted deployment if the snapshot itself is bad. Production variables stay unchanged.
