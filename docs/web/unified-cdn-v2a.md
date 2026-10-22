# AzerDex unified asset pipeline — V2-A (atlas + cinematic zone heroes)

Status: **`V2A_ASSET_PIPELINE_READY`** — prepared, validated locally, **nothing uploaded, deployed, merged or promoted**. No Cloudflare, DNS, Vercel-environment,
Supabase, API or Companion change. Upload and rollback: [`map-atlas-cdn-deploy.md`](map-atlas-cdn-deploy.md#unified-snapshot-v2-a-atlas--cinematic-zone-heroes--upload-and-rollback).
Performance baseline for the later Vercel-vs-Cloudflare comparison: [`zone-hero-performance-baseline.md`](zone-hero-performance-baseline.md).

## What this adds
The existing atlas pipeline (`scripts/map-atlas`) gains one command, `build-unified`, that produces **one complete Pages snapshot**: the owner's approved atlas distribution
(read-only baseline) **plus** versioned cinematic zone heroes. It extends `packaging.py` / `remote.py` / the ledger model; there is no parallel deployment system.

```
dist/
  _headers                         baseline /forever/* + /atlas/* rules verbatim, then a /zone-heroes/* block
  atlas/{index,hierarchy,builds,instances}.json          byte-identical to the baseline
  forever/{uiMapID}/{vN}/…                               byte-identical to the baseline (60 maps, 61 immutable versions, 167 files)
  zone-heroes/1424/v1/{desktop-1280,desktop-2000,mobile-600,mobile-900}.webp     Hillsbrad Foothills
  zone-heroes/1431/v1/{desktop-1280,desktop-1916,mobile-600,mobile-900}.webp     Duskwood
```
Hero art is **not** mixed into atlas manifests or catalogs (checked: no atlas JSON mentions `zone-heroes`); `zone-heroes` is independently versioned.
Cloudflare Pages Direct Upload deploys whole snapshots, so the builder only ever emits baseline ∪ heroes (a hero-only folder cannot be produced).

## The baseline and what could (not) be verified
| | |
| --- | --- |
| Archive | `atlas-dist-1.60.1.70450.zip` (owner-supplied, 26,070,951 bytes), sha256 `f8a3df96cf9567c8abcd5b80b71d21f6ef44bb09fe455b70b8f32ea75c32c847` |
| Matches the repository's own record | the sha256 is the `approvedDistributionZipSha256` committed in `web/src/lib/maps/atlas/atlas-index.snapshot.json`, and the archive's `atlas/index.json` hashes to that snapshot's `indexJsonSha256` (`5d2b2bc1…8e7c`) — independent confirmation that it is the approved distribution |
| Content | 172 files = `_headers` + 4 atlas catalogs + 167 files under `forever/` (60 maps, 61 versions: `1420/v1` legacy POC and `1420/v2`, one `v1` for each other map; 106 WebP images, 61 manifests); client build `1.60.1.70450` |
| Pin | `scripts/map-atlas/baseline/atlas-dist-1.60.1.70450.json`: every path with size and SHA-256 (no artwork in Git). `build-unified` refuses (`BLOCKER - baseline cannot be recovered and verified`) on any missing, extra or changed file, wrong archive hash, unsafe/duplicate/symlink entry, or a `_headers` that is not the reviewed atlas rule set. Nothing is reconstructed from guesses |
| Committed ledger | `ledger/published.json` is a subset of the pin (`forever/1420/v1` byte-identical) |
| **Not verifiable here** | the **live CDN**: `azerdex-assets.pages.dev` answers `CONNECT 403` from this sandbox (the same limitation earlier sessions recorded). Step 0.3 of the upload guide runs `verify-remote` against the baseline from an unrestricted machine **before** anything is uploaded |
| Ledger drift (finding) | `ledger/published.json` still lists only `1420/v1`: the baseline was never promoted into it (promotion is an after-upload step). The unified build therefore uses the **pin** as the authority for "nothing published may change", and proposes the complete map ledger (`ledger.next.json`: published.json + the 60 baseline versions, derived only from the verified baseline) for promotion after a verified upload |

## Hero inventory (`scripts/map-atlas/heroes/zone-heroes.json`)
The auditable, append-only record and the batch-friendly input: `zones → {uiMapID} → versions → {vN} → { approval, watermark, provenance, privateMaster, renditions[] }`.
```jsonc
"1424": { "name": "Hillsbrad Foothills", "versions": { "v1": {
  "approval":   { "status": "approved", "approvedBy": "repository owner", "date": "2026-10-21", "legalClearance": "not-cleared", "note": "…" },
  "watermark":  { "status": "embedded", "appliedBeforeResize": true, "emblem": "web/public/icon.svg", "tint": "#e8cf8f", "opacity": 0.17, "sizePx": 56, "centre": [985, 40] },
  "provenance": { "reference": "docs/azerdex-hero-art/provenance.md#…", "masterSha256": "a0e6b402…", "masterDimensions": "2000x667", "attestation": "…", "mobileCrop": "x760-2000 of the master" },
  "privateMaster": { "inRepository": false },
  "renditions": [ { "file": "desktop-2000.webp", "width": 2000, "height": 667, "bytes": 103602, "sha256": "fbc70e48…", "source": "1424-hillsbrad-foothills-2000.webp" }, … ] } } }
```
`file` is the published name (`desktop|mobile-<width>.webp`), `source` the same-origin rollback copy in `web/public/zones/hero/`. Adding a zone or a new artwork version = add an entry
(`atlas.py hero-measure --dir <derivatives>` prints the rendition records), add the registry entry in `zone-artwork.ts`, record provenance. Versions must be contiguous from `v1`
(append-only); a published version is never edited. The pilot set is the eight approved derivatives already on `web/azerdex-beta` (not regenerated, not re-encoded, byte-for-byte).

## Validation matrix (all enforced by `build-unified` / `verify-unified`; tests in `scripts/map-atlas/tests/test_unified.py` unless noted)
| Requirement | Enforcement |
| --- | --- |
| Deterministic output | sorted entries, fixed timestamps/modes; two builds give identical dist, zip, reports and ledger proposals (`test_deterministic_zip_and_reports`); real build run twice → same zip sha256 |
| Validated paths and filenames | atlas/forever names per the existing convention; heroes `zone-heroes/<1..999999>/v<N>/(desktop\|mobile)-<w>.webp`; baseline archive path safety; no traversal, case conflicts, symlinks |
| SHA-256 for all published assets | `SHA256SUMS.txt`, `dist-files.json`, audit inventory (`zone-heroes-inventory.json`) with hash and size found in the dist |
| Correct image dimensions + WebP decoding | each rendition decoded with Pillow; size must equal the inventory; renditions of one crop share its aspect ratio (±1 px) |
| Watermarked derivatives only / no private master | inventory must declare `watermark.status=embedded`, `appliedBeforeResize`, opacity in the owner-approved 12–18 % band, `privateMaster.inRepository=false`; a file whose bytes equal the recorded master hash is refused; source names containing `source/master/original/raw/unwatermarked` are refused; only VP8/VP8L/VP8X/ALPH chunks (no EXIF/XMP/ICC, no animation); source dir must contain nothing but the inventoried files. **Limit:** a watermark cannot be proven from pixels; it rests on the hash-pinned approved files and the provenance record |
| No unapproved or unexpected files | the dist file set must equal pin ∪ inventory renditions exactly (no `index.html`, no extra hero, no missing file); `approval.status` must be `approved` |
| Cloudflare Pages limits | ≤ 20,000 files (Free), ≤ 25 MiB per file, ≤ 100 `_headers` rules, ≤ 2,000 characters per `_headers` line; per-hero budget 512 KiB. Verified against the Cloudflare Pages limits documentation |
| Append-only version history | maps: baseline pin + `ledger/published.json` superset check; heroes: `ledger/zone-heroes.json` (empty until the owner promotes after a verified upload) — a published hero file changed in place or a removed version fails; new art must be `vN+1`; `promote-*` refuse any change/removal |
| No modification of previously published files | every pinned path except `_headers` must be byte-identical (`test_dist_is_exactly_baseline_plus_the_eight_hero_files…`) |

## Headers
`_headers` = the baseline text unchanged (prefix, asserted) + a blank line + `/zone-heroes/*`:
`Cache-Control: public, max-age=31536000, immutable`, `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `Timing-Allow-Origin: *`.
`/forever/*` and `/atlas/*` behaviour is unchanged. Notes: `Content-Type` is **not** overridden (Pages derives `image/webp` from the extension; the verifier requires it on served files);
CORS is not needed by an `<img>` without `crossorigin`, it is kept for consistency with `/forever/*` and for future `fetch`/canvas use; `Timing-Allow-Origin` lets Resource Timing report the real
size/duration of the cross-origin hero (needed for the performance comparison; proven in a real browser by `zone-hero-cdn.spec.ts`). Versioned URLs are immutable, so a one-year immutable cache is safe.
`verify-remote` (post-upload, read-only) additionally checks type, `nosniff`, timing header and that unknown asset paths return **HTTP 404** — Pages serves its SPA fallback when a project has a top-level
`index.html`/no `404.html`, which this snapshot deliberately does not have (the exact file set check forbids an `index.html`).

## Web integration (prepared, **not switched on**)
`web/src/lib/maps/zone-artwork.ts` resolves a hero from a registry (`version` + renditions) to URLs for one of two sources:

| `AZERDEX_ZONE_HERO_SOURCE` | Hero URLs |
| --- | --- |
| unset / anything but exactly `cdn` (**default, what the beta runs**) | same-origin `/zones/hero/<id>-<slug>-<width>.webp` — the rollback path, files stay in the repository |
| `cdn` | `<NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL>/zone-heroes/<uiMapID>/<version>/<role>-<width>.webp` |

* **Reuses the validated host configuration** (`parseAssetBase` allow-list: https, `azerdex-assets.pages.dev` / `assets.azerdex.com`, no port/userinfo/query). An unset or invalid base with `cdn` silently keeps the same-origin files; a malformed zone/version/file name throws and falls back the same way.
* **A separate flag on purpose:** the beta already sets the asset base for the atlas maps, so reusing it alone would have flipped the heroes to a CDN that has no `zone-heroes/` yet. The flag is server-side only (no `NEXT_PUBLIC_`), read per request.
* **No additional requests:** URLs are pure string construction in the server component; the client makes exactly the image requests it made before.
* **Unchanged:** `ZoneCinematicHero.tsx` (as of V2-A; since then only the crop moved from an inline style to a focal class, see zone-cinematic-hero.md; markup identical across sources once URLs are normalised — unit-tested), the renditions/widths/`srcset`/`sizes`, intrinsic size, `fetchPriority="high"`, object-position, and the resolution order cinematic → atlas map → vector fallback.
* **CSP:** with `cdn`, `img-src` (only `img-src`, not `connect-src`) gains the one validated origin on every HTML document (client-side navigation keeps the first document's CSP); with the default the CSP is byte-identical to today (unit-tested).
* **Failure behaviour:** the hero keeps the vector backdrop and all text if a CDN image fails (E2E: outage test); there is deliberately no client-side fallback script (the component stays unchanged). Rollback is flipping the flag (see the deploy guide).
* **Migration plan:** (1) V2-A: pipeline + code, default same-origin; (2) owner uploads the unified snapshot and verifies; (3) Preview with `cdn`, measure against the baseline; (4) Production flag; (5) only later remove the same-origin copies (a separate decision — they are the rollback path).

## Report of the real build (from the owner's baseline zip; reproduce with `build-unified`, deterministic)
Distribution label `1.60.1.70450+heroes.8da4f1345f65` · **180 files** (172 baseline + 8 heroes; Pages Free limit 20,000) · 26,956,781 bytes · largest file 300,272 bytes (limit 26,214,400) · `_headers` 3 rules (limit 100).
| Namespace | Files | Bytes |
| --- | ---: | ---: |
| `_headers` | 1 | 423 |
| `atlas/` | 4 | 188,230 |
| `forever/` | 167 | 26,214,520 |
| `zone-heroes/` | 8 | 553,608 |

Zip `azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip`: 26,625,948 bytes, sha256 `339858b25d42eb06699510ab63092917138264efbd993d79e702df76768b1e15` (two independent builds were byte-identical).
Hero inventory sha256 `493248b53c7183f37c14340a5c67375e800d0aa892c2968d5951957101fb7ea0`. Hero files (published path · bytes · sha256):

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| `zone-heroes/1424/v1/desktop-1280.webp` | 56,890 | `9dc58eb3afdd2f86d0beec90f0230cd0c27e492e6b8122b502acb2184f74e880` |
| `zone-heroes/1424/v1/desktop-2000.webp` | 103,602 | `fbc70e484f13e6eea1ad965d1dc4c211c731dc08893daeb426d7e41b416fde07` |
| `zone-heroes/1424/v1/mobile-600.webp` | 30,614 | `50e481ad12038ba65ab06fe838ea8ab4e721c91d963a6e9dec58c73e6c1d91d2` |
| `zone-heroes/1424/v1/mobile-900.webp` | 57,650 | `cc87be9a4b5970afcf5b28fb5a05b0741721b65c22b980c52e8f3e25434dae72` |
| `zone-heroes/1431/v1/desktop-1280.webp` | 63,462 | `0202c6857a61696c6e3d0a298e5ded5a0a5dfb43ead3de011a850d77d1c27299` |
| `zone-heroes/1431/v1/desktop-1916.webp` | 112,782 | `bf118ae7764a4c20b3392ea245cee272e0bd2b43147579c940b1579e30e49080` |
| `zone-heroes/1431/v1/mobile-600.webp` | 45,462 | `5d27f395774108672465042d1ffcba9cf515ede847382f21a08dc4632903a8e0` |
| `zone-heroes/1431/v1/mobile-900.webp` | 83,146 | `60652b0d84f17a919b980caa2f9eb3b382002885c84c8c59aa47239d85cb0985` |

(The full SHA-256 of every file of the dist is in the build's `SHA256SUMS.txt`/`dist-files.json`; the baseline's 172 are pinned in `baseline/atlas-dist-1.60.1.70450.json`.)

## Cost
Zero additional monthly cost: the existing Cloudflare Pages Free project `azerdex-assets`; 180 files (0.9 % of 20,000), 26.96 MB total, largest 300 KB; no R2, paid Cloudflare feature, database/Supabase change, API change or UI redesign. The same-origin copies stay in Vercel's bundle (553 KB) until the cleanup decision.

## Remaining blockers and assumptions
1. Live-CDN equality with the baseline is **unverified** (CDN unreachable from the preparation sandbox) — step 0.3 of the upload guide is mandatory before approval.
2. `ledger/published.json` predates the baseline's upload (finding above); ledger promotion happens after a verified upload.
3. Hero artwork is owner-supplied and approved for the beta but **not legally cleared** (recorded per version, `legalClearance: not-cleared`); publishing to a public CDN is subject to the owner's licensing decision (open items in `docs/azerdex-hero-art/provenance.md`). The same-origin copies are already public on the beta, so the CDN adds no new exposure of the files themselves.
4. The first Hillsbrad commit of #93 briefly contained unwatermarked derivatives in that PR's history (documented in the provenance record); this PR adds none of those files.
5. Watermark presence is attested by provenance + hash pinning, not detectable from pixels.
6. Pages' unknown-path behaviour (404 vs. fallback) is verified only by `verify-remote` after an upload.
