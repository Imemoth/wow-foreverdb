# V2-B — Cloudflare CDN pilot for the cinematic zone heroes (Hillsbrad Foothills 1424, Duskwood 1431): preflight and runbook

Verdict: **`V2B_PREFLIGHT_BLOCKED`** — everything that can be prepared and verified without Cloudflare access is done and passes; **one gate cannot be closed from the preparation environment: read-only
equality of the live `azerdex-assets.pages.dev` with the 172-file baseline** (and with it the rollback deployment ID). Both need the owner's machine (steps A4/A5 below, ~5 minutes, read-only).
Nothing was uploaded, no Vercel variable changed, no hero activated, nothing merged or promoted. Builds on [`unified-cdn-v2a.md`](unified-cdn-v2a.md) (pipeline), [`map-atlas-cdn-deploy.md`](map-atlas-cdn-deploy.md) and
[`zone-hero-performance-baseline.md`](zone-hero-performance-baseline.md).

## 1. What was verified (evidence, 2026-10-22)
| Check | Result |
| --- | --- |
| Repository | `web/azerdex-beta` @ `e16c937` contains #96 (`b4e86df`) and #99 (`b10538e`); pipeline, artwork, hero component, CSP/headers code **unchanged** since #99 (later commits are News and auth-confirm only) |
| Hero derivatives on GitHub | all 8 blobs of `web/public/zones/hero/` have exactly the git blob SHA-1s GitHub's API reports for `web/azerdex-beta`; their SHA-256, size, dimensions and WebP decode equal the inventory |
| Rebuild from the approved original backup | `atlas-dist-1.60.1.70450.zip` (sha256 `f8a3df96…c847`, = the repository's recorded `approvedDistributionZipSha256`) verified against its pin (172/172), then `build-unified` → **180 files**, `verify-unified` OK |
| **Validated distribution** | `azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip` · 26,625,948 bytes · **SHA-256 `339858b25d42eb06699510ab63092917138264efbd993d79e702df76768b1e15`** — byte-identical to the V2-A build (deterministic) |
| Independent re-check of that zip (stdlib script, not the pipeline) | 180 entries, 0 duplicates; every entry = `SHA256SUMS.txt`; all 172 baseline paths present and unchanged (except `_headers`, which only gained the hero block); 61 immutable map versions (60 maps) with every manifest/`image`/variant hash+size resolving; `atlas/index.json` versions = directories; 114 WebP decode (106 atlas + 8 heroes); ledger `1420/v1` intact; hero hash/size/dimensions = inventory; no `index.html`/`404.html` |
| Headers | `_headers` = baseline rules verbatim + `/zone-heroes/*` (immutable 1 y, CORS `*`, nosniff, Timing-Allow-Origin); 3 rules (limit 100); per-file header resolution checked for all 179 served files; Pages limits: 180 files (20,000), largest 300,272 B (25 MiB) |
| Release record | `scripts/map-atlas/baseline/unified-dist-1.60.1.70450-8da4f1345f65.release.json`: all 180 paths with size + SHA-256 (what the live CDN must serve after the upload); a unit test ties it to pin ∪ inventory ∪ headers |
| Live CDN, read-only | **NOT VERIFIED — blocked**: `curl` → proxy `CONNECT 403`; the web-fetch tool → `ENOTFOUND`; the Vercel fetch tool cannot read third-party hosts; the Cloudflare MCP server failed to connect and its toolset has no Pages-deployment API. No PASS is claimed. Use A4 |
| Current Pages production deployment ID (rollback target) | **NOT ACCESSIBLE** from here (same reason). Use A5; do not upload before it is recorded |
| Vercel beta, read-only | `beta.azerdex.com` (deployment `dpl_C8U1hiA3…`, commit `b10538e`): heroes are same-origin `/zones/hero/…` (flag unset), CSP `img-src 'self' data: https://azerdex-assets.pages.dev` (the CDN origin is **already allowed**, because the atlas asset base is configured), `style-src` nonce only. Env-var listing is not permitted for this connector (403), so the variable set was inferred from behaviour, not read |
| Tooling tested | `Verify-AzerdexCdn.ps1` (below) executed under PowerShell 7.5.3 against a local Pages stand-in: PASS and each defect class FAIL, unreachable host never PASS (7 tests, run in CI where `pwsh` exists). **Not executed under Windows PowerShell 5.1** (none here); written to 5.1 semantics (see A4 note) |

## 2. Owner prerequisites (Windows)
Git, Node ≥ 20 (`npx wrangler`), PowerShell 5.1 or 7, this repository at `web/azerdex-beta`, the approved `atlas-dist-1.60.1.70450.zip`, a Cloudflare login with Pages edit rights for the `azerdex-assets` project
(`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), and — for the website step — Vercel access to the `wow-foreverdb` project (`npx vercel login`). The unified zip is the same one this session delivers; or rebuild it:
```powershell
git fetch origin; git checkout web/azerdex-beta; git pull
python -m pip install -r scripts\map-atlas\requirements.txt
python scripts\map-atlas\atlas.py build-unified --baseline C:\azerdex\atlas-dist-1.60.1.70450.zip --out C:\azerdex\out
#  -> READY_FOR_APPROVED_UPLOAD · 1.60.1.70450+heroes.8da4f1345f65 · files 180 · zip sha256 339858b2…1e15  (any other sha: STOP)
```
The artwork zip is game art: keep it private; never commit it.

## 3. Cloudflare Pages procedure (every step after A5 needs your explicit approval; **nothing here has been run**)
**A. Before anything is uploaded (read-only)**
1. **A1** `git log --oneline -1` is a descendant of `b10538e`; `git status` clean.
2. **A2** Build or take the zip (above). Compare `Get-FileHash <zip> -Algorithm SHA256` with `339858b25d42eb06699510ab63092917138264efbd993d79e702df76768b1e15`.
3. **A3** `powershell -ExecutionPolicy Bypass -File scripts\map-atlas\windows\Verify-AzerdexCdn.ps1 -Mode Local -LocalDist C:\azerdex\azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip` → **`PASS: 180/180`** (verifies the exact bytes you will upload; also catches extra files).
4. **A4 — GATE: the live CDN must still be the baseline.** `.\Verify-AzerdexCdn.ps1 -Mode Baseline` (read-only GETs of 171 files + 404 probes) → must print **`PASS: 171/171 … 0 warning(s)`**; keep the evidence JSON.
   A Pages Direct Upload is a **complete snapshot**: files that are live but not in the upload disappear from the new deployment. Therefore: any FAIL/WARN = **stop and report** (`bytes differ`/`HTTP 404` ⇒ the live state differs from the baseline; `zone-heroes … already served` ⇒ heroes were published before).
   Windows PowerShell 5.1 note: the script uses only 5.1 cmdlets (`Invoke-WebRequest -UseBasicParsing`, `Get-FileHash`); if your environment forces an old TLS default it sets TLS 1.2 itself. If it cannot reach the host the verdict is FAIL, never PASS. Equivalent without PowerShell: `python scripts\map-atlas\atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist <extracted atlas-dist folder>`.
5. **A5 — record the rollback target.**
   ```powershell
   npx wrangler pages project list                                        # the project must be Direct Upload (Git Provider: No); note the production branch name
   npx wrangler pages deployment list --project-name azerdex-assets --json | Out-File deployments-before.json -Encoding utf8
   ```
   Write down the `Id` (and URL/created time/branch) of the newest `Production` deployment — **that is the rollback target** — and screenshot Dashboard → Workers & Pages → `azerdex-assets` → Deployments. A Git-integrated project cannot take Direct Upload: stop and report.

**B. Preview deployment of the exact snapshot (recommended dry run; production URL untouched)** — only if the production branch is not named `v2b-heroes-preview`:
```powershell
npx wrangler pages deploy C:\azerdex\out\dist --project-name azerdex-assets --branch v2b-heroes-preview --commit-message "V2-B preview 8da4f1345f65" --commit-dirty=true
# prints https://<hash>.azerdex-assets.pages.dev
.\Verify-AzerdexCdn.ps1 -Mode Post -BaseUrl https://<hash>.azerdex-assets.pages.dev     # -> PASS: 179/179
```
(A branch other than the production branch creates a *preview* deployment; the live `azerdex-assets.pages.dev` is not changed. Preview URLs are public like the site itself.)

**C. Production deployment (second explicit approval)**
```powershell
npx wrangler pages deploy C:\azerdex\out\dist --project-name azerdex-assets --branch <PRODUCTION BRANCH FROM A5> --commit-message "V2-B: atlas 1.60.1.70450 + zone-heroes v1 (8da4f1345f65)" --commit-dirty=true
.\Verify-AzerdexCdn.ps1 -Mode Post          # https://azerdex-assets.pages.dev -> must be PASS: 179/179, 0 failures
python scripts\map-atlas\atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist C:\azerdex\out\dist    # second, independent verifier
```
No new project, no DNS/custom-domain change, no `_redirects`/Functions. Expect: the 172 baseline URLs unchanged byte-for-byte (immutable cache), new URLs `…/zone-heroes/1424|1431/v1/…` (HTTP 200, `image/webp`, `Cache-Control: public, max-age=31536000, immutable`, CORS `*`, nosniff, `Timing-Allow-Origin: *`), unknown paths 404.
**Any FAIL ⇒ roll back immediately (section 5) and report.**

**D. After a PASS**: promote the ledgers (append-only) and commit them on a branch/PR:
`python scripts\map-atlas\atlas.py promote-ledger --from C:\azerdex\out\ledger.next.json` and `… promote-hero-ledger --from C:\azerdex\out\zone-heroes-ledger.next.json`. From then on any change to a published file fails the build; new art ⇒ `v2`.

## 4. Vercel beta activation (separate approval; Preview, branch `web/azerdex-beta` only — never Production)
Preconditions: C passed; the beta CSP already allows `https://azerdex-assets.pages.dev` in `img-src` (observed); `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` is set on beta (observed via the CSP).
1. **Baseline of the current state (before)** — saves evidence and performance numbers:
   ```powershell
   node web\scripts\hero-cdn-smoke.mjs --site https://beta.azerdex.com --expect local --out smoke-before.json     # PASS: same-origin heroes, class crop, strict CSP
   node web\scripts\hero-perf-probe.mjs --vercel https://beta.azerdex.com --cloudflare https://azerdex-assets.pages.dev --runs 10 --out probe-1.json
   ```
2. **Set the variable** (Preview only, this branch only): Dashboard → `wow-foreverdb` → Settings → Environment Variables → Add → name `AZERDEX_ZONE_HERO_SOURCE`, value `cdn`, Environments: *Preview*, branch `web/azerdex-beta`; or
   `npx vercel env add AZERDEX_ZONE_HERO_SOURCE preview web/azerdex-beta` (enter `cdn`). It is server-side only (no `NEXT_PUBLIC_`) and read per request.
3. **Redeploy** the latest `web/azerdex-beta` deployment (Dashboard → Deployments → ⋯ → Redeploy; or `npx vercel redeploy <deployment-url>`): variables apply to new deployments.
4. **Smoke tests** (Hillsbrad and Duskwood):
   ```powershell
   node web\scripts\hero-cdn-smoke.mjs --site https://beta.azerdex.com --expect cdn --out smoke-after.json
   ```
   asserts per zone: HTTP 200; `<source>`/`<img>` `srcset`, `src`, `sizes`, intrinsic size, `fetchpriority=high` exactly as today but on `https://azerdex-assets.pages.dev/zone-heroes/<id>/v1/…`; crop = stylesheet class (`hero-pos-85-50` / `hero-pos-85-45`), no inline style; CSP strict (no `unsafe-inline`), `img-src` = `'self' data:` + the one CDN origin; all 8 files fetched with the inventory's exact bytes and headers.
   Manual: open `https://beta.azerdex.com/zone/1424` and `/zone/1431` on desktop and a phone (or DevTools device mode): DevTools → Network → the hero request is `azerdex-assets.pages.dev/zone-heroes/…` status 200, Console shows **no** CSP message, the crop matches the approved render, the map below still loads.
5. **Performance comparison** (the Vercel-vs-Cloudflare baseline, protocol in [`zone-hero-performance-baseline.md`](zone-hero-performance-baseline.md) §4): rerun the probe (`probe-2.json`, from ≥ 3 regions/times), plus Lighthouse (mobile and desktop, ≥ 5 runs) on both states; record LCP, hero TTFB/download, cache status (`cf-cache-status`, `x-vercel-cache`), extra connection cost. Suggested acceptance: Cloudflare median hero download ≤ same-origin median (warm) and LCP not worse by more than noise (±10 %); otherwise keep `local`.
6. If anything is wrong → section 5.2 (one variable, one redeploy).

## 5. Rollback plan
1. **Website (fast, no data involved)**: remove the variable (`npx vercel env rm AZERDEX_ZONE_HERO_SOURCE preview web/azerdex-beta`, or set it to `local`) and redeploy (or use Vercel's instant rollback to the previous deployment). The same-origin files are still in the repository and the app. Verify: `hero-cdn-smoke.mjs --expect local` → PASS.
2. **Cloudflare**: Dashboard → Workers & Pages → `azerdex-assets` → Deployments → the deployment ID recorded in A5 → ⋯ → *Rollback to this deployment* ([Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/): reverts the project to a previous production deployment). Then `Verify-AzerdexCdn.ps1 -Mode Baseline` → must be `PASS 171/171` again (the hero URLs 404 again; the website must be on `local` first, step 1, or its heroes would break). Alternative if the dashboard rollback is unavailable: re-deploy the original 172-file atlas-dist (extract the baseline zip to a folder, `wrangler pages deploy <folder> --project-name azerdex-assets --branch <production branch>`), then verify as above.
3. **Ledgers**: not promoted before a PASS; if promoted and the deployment was rolled back, revert that commit. Never delete Pages deployments or published files; a wrong hero is fixed with `v2`, not by editing `v1`.
Order for a full back-out: 1 (website) → 2 (Cloudflare) → 3.

## 6. Remaining blockers and exact owner actions
1. **A4 — live-CDN equality with the baseline (PASS 171/171) — OPEN (blocks deployment).** Run the Baseline mode and send the evidence JSON.
2. **A5 — rollback deployment ID — OPEN.** Run the two `wrangler` commands, note the production deployment ID.
3. Confirm the project is Direct Upload and name the production branch (A5); otherwise B/C cannot be run as written.
4. Explicit approval for B (preview upload, optional), C (production upload), D (ledger promotion PR) and, separately, §4 (Vercel variable on Preview/`web/azerdex-beta`).
5. Hero art is owner-approved but **not legally cleared**: publishing it on a public CDN is subject to your licensing decision (already public on the beta; the CDN adds a second URL, not new exposure of the files).
6. Residual risk: the PowerShell script has not run under Windows PowerShell 5.1 here (PowerShell 7 only); if it misbehaves, use `verify-remote` (Python) — both are read-only.
