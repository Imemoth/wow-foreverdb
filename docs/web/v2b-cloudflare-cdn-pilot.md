# V2-B — Cloudflare CDN pilot for the cinematic zone heroes (Hillsbrad Foothills 1424, Duskwood 1431): preflight and runbook

Verdict: **`V2B_CDN_DEPLOYED_VERIFIED`** — the unified snapshot (atlas baseline + 8 zone-hero derivatives) is live on the Cloudflare Pages project `azerdex-assets` (Production, branch `main`) and passed the Post verification (179/179).
**CDN-served heroes are NOT activated**: the Vercel beta still serves same-origin heroes; activation is a separate step (§4). Production Vercel, the ledgers and every other system are untouched.
Builds on [`unified-cdn-v2a.md`](unified-cdn-v2a.md) (pipeline), [`map-atlas-cdn-deploy.md`](map-atlas-cdn-deploy.md) and [`zone-hero-performance-baseline.md`](zone-hero-performance-baseline.md).
**Neither the audit nor this record is licensing clearance for the artwork** (§6).

## 0. Deployment record (2026-10-22)
| Fact | Value | Source |
| --- | --- | --- |
| Project / environment / branch | `azerdex-assets` / Production / `main` | owner, from the authenticated Cloudflare API |
| **New production deployment** | **`04effe36-d1e6-45b8-a529-fa32136d1b38`**, status success; served asset manifest 179 files including all 8 hero derivatives | owner, from the authenticated Cloudflare API (not read by this session: the sandbox has no Cloudflare API access) |
| Uploaded package | `azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip`, 180 files, SHA-256 `339858b25d42eb06699510ab63092917138264efbd993d79e702df76768b1e15` (hash re-verified here before the upload) | this session |
| **Rollback target** | **`3ae723a0-df00-4dcd-9159-8ba93d0583aa`** (previous production, 171 served baseline files; its own URL `3ae723a0.azerdex-assets.pages.dev` still serves them) | owner + this session |
| **Post verification** | `V2-B CDN read-only verification`, mode Post, `https://azerdex-assets.pages.dev`: **PASS 179/179, 0 failures, 0 warnings** — [run 39816836056](https://github.com/Imemoth/wow-foreverdb/actions/runs/39816836056), evidence artifact 12442018037 | this session (full-byte download, every file's size + SHA-256 = the release record) |
| Headers observed | 61 manifests `application/json` + 114 `image/webp`, all `public, max-age=31536000, immutable`; 4 atlas JSON `public, max-age=300, must-revalidate`; hero sample: `image/webp`, immutable, CORS `*`, `nosniff`, `Timing-Allow-Origin: *`; unknown paths / `_headers` / `index.html` / `404.html` / `/` → 404 `no-store` | run log |
| Existing atlas | the 171 baseline files are byte-identical to the approved baseline (same content as before the upload) | run 39816836056 (a subset of the 179) |

The rollback ID and the new deployment ID are two independent facts: the first from before the upload (audit), the second from after it (Cloudflare API, owner). Rollback procedure: §5.

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
| Vercel beta, read-only | `beta.azerdex.com` (deployment `dpl_C8U1hiA3…`, commit `b10538e`): heroes are same-origin `/zones/hero/…` (flag unset), CSP `img-src 'self' data: https://azerdex-assets.pages.dev` (the CDN origin is **already allowed**, because the atlas asset base is configured), `style-src` nonce only. Env-var listing is not permitted for this connector (403), so the variable set was inferred from behaviour, not read |
| Tooling tested | `Verify-AzerdexCdn.ps1` under PowerShell 7.5.3 against a local Pages stand-in (PASS and every defect class FAIL; unreachable host never PASS; 7 tests), **and for the first time on a real network** on a GitHub-hosted runner (PowerShell 7.6.6, runs `39808968821` and `39809465072`, §1.1). Not executed under Windows PowerShell 5.1 |

### 1.1 Live baseline: verified asset integrity and HTTP checks
| Evidence | Result | Source / independence |
| --- | --- | --- |
| **Asset integrity, method A** — owner's Cloudflare API audit `d006060d-azerdex-v2b-cdn-baseline-audit-2026-10-22.json` (stored byte-exact in `docs/web/evidence/`, sha256 `9eda4c5eb864ba22c0c771c9d58f4c88310998e987ddde146bd9e940cc3950c1`) | `PASS_FILE_CONTENT_ID_MATCH_171_OF_171`: Cloudflare's own content ID of every served file = the ID computed from the approved baseline zip | Live side supplied by the owner (Cloudflare API); **methodology independently reproduced by me** (below) |
| Audit methodology validated | Content ID = `BLAKE3(base64(bytes)+ext)[:32]` recomputed by me from the private baseline zip for all 171 files = the audit's IDs; manifest fingerprint `b5b9c973…f7cf` recomputed from the audit's own IDs; audit path/size/SHA-256 list = the repository pin minus `_headers` (171 files); both zip hashes = pin and release record; its `not_verified` list is exactly the four items it states. Test: `scripts/map-atlas/tests/test_cdn_audit_evidence.py` (the BLAKE3 recompute needs the private zip via `ATLAS_BASELINE_ZIP`; it ran and passed) | Mine, offline |
| **Asset integrity, method B** — full-byte HTTP download from a GitHub-hosted runner (Actions runs `39808968821` and `39809465072`, artifact `v2b-cdn-verification-evidence` 12440375008 holds the evidence JSON) | `Verify-AzerdexCdn.ps1 -Mode Baseline`: **PASS 171/171, 0 failures, 0 warnings**, SHA-256 and size of every file equal the pin, on **both** `https://azerdex-assets.pages.dev` and the recorded production deployment URL `https://3ae723a0.azerdex-assets.pages.dev` | Mine; measures what clients actually receive |
| Response headers / content types / cache policy | All 171 files: HTTP 200 and the baseline `_headers` policy (verified per file by the script): 167 immutable files `public, max-age=31536000, immutable` (61 manifests `application/json`, 106 `image/webp`) and 4 atlas JSON files `public, max-age=300, must-revalidate` (`Cache-Control` compared as a directive set). Raw `curl` dump of 6 sampled files additionally shows `Access-Control-Allow-Origin: *`, `X-Content-Type-Options: nosniff`, `server: cloudflare` and an `ETag` **equal to that file's Cloudflare content ID in the audit** (6/6) | Mine, runner log + evidence JSON |
| Expected 404s | unknown map `forever/9999999/v1/manifest.json`, `atlas/not-a-file.json`, `zone-heroes/1424/v1/desktop-1280.webp` and `…/9999999/…`, `zone-heroes/1424/v999/…`, `index.html`, `404.html`, `/` and `_headers` → **HTTP 404**, `Cache-Control: no-store`, empty body (the `zone-heroes` 404 proves the heroes are not live yet) | Mine |
| Recorded production deployment | `3ae723a0-df00-4dcd-9159-8ba93d0583aa` (project `azerdex-assets`, production branch `main`, trigger `ad_hoc`, status `success`): its own deployment URL serves the identical 171 files (PASS 171/171) | API facts: owner-reported; content equality: mine |

Consequence for the upload: the unified snapshot (180 files, 179 served) contains **exactly the 171 verified served files plus 8 new `zone-heroes` files**; nothing that is live is missing from it, so the snapshot cannot remove a live file.

### 1.2 Not verified (stated plainly)
| Item | Status | When / how it will be checked |
| --- | --- | --- |
| Direct Upload and production branch `main`, **via the Cloudflare API, by me** | **Unverified by me** — only the owner's audit says so (sandbox cannot reach `api.cloudflare.com`; no credentials; no Cloudflare MCP connection). Indirectly consistent: trigger type `ad_hoc` is what a Direct Upload deployment reports | Optional workflow step (read-only; only runs when the repository secrets `CLOUDFLARE_API_TOKEN` (Pages: Read) and `CLOUDFLARE_ACCOUNT_ID` exist) prints it and **fails if the production deployment is not `3ae723a0…`**; otherwise the owner confirms it on the dashboard in step A3 |
| That `3ae723a0…` is **still** the current production deployment at upload time | Owner-reported at audit time; the live content equals it today (§1.1) | A3, immediately before the upload (dashboard, 10 seconds) |
| `/zone-heroes/*` response headers (`image/webp`, immutable, CORS, nosniff, Timing-Allow-Origin) and bytes | Cannot exist before the upload | `Post` mode, right after the upload (§3 D) |
| Real-browser hero decode / CSP / crop from the CDN | Not possible before activation | Vercel smoke test §4 |
| Windows PowerShell 5.1 | Never run | Not needed: verification runs on GitHub (PowerShell 7) |
| Artwork licensing | **Out of scope for the audit and for this work** | Owner decision, §6 |

## 2. Owner prerequisites (no local tooling)
A browser logged in to the Cloudflare dashboard with edit rights on the Pages project `azerdex-assets`, the unified zip delivered by this session (`azerdex-cdn-dist-1.60.1.70450-8da4f1345f65.zip`, SHA-256 `339858b25d42eb06699510ab63092917138264efbd993d79e702df76768b1e15`; the same bytes can be regenerated from the repository by `atlas.py build-unified`
if the approved baseline zip is available), and — only for the later website step — Vercel dashboard access. **No Git checkout, Node, Python, PowerShell or Windows command is required**: the verification runs on GitHub-hosted runners (`.github/workflows/v2b-cdn-verify.yml`) and is started by this session through the GitHub API (or from the repository's *Actions* tab → *Run workflow* by anyone with write access).
The artwork zip is game art: keep it private; never commit it.

## 3. Cloudflare Pages procedure (executed 2026-10-22 as B and C; result in §0; kept as the repeatable procedure for the next version)
**A. Immediately before the upload (read-only; ~2 minutes)**
1. **A1 Zip identity** — the file you upload has SHA-256 `339858b2…1e15` (Windows *PowerShell* `Get-FileHash`, macOS/Linux `shasum -a 256`, or any online-free hash tool; or tell this session the hash you see).
2. **A2 Baseline still live** — this session runs `V2-B CDN read-only verification`, mode **Baseline**, (`workflow_dispatch` on the branch that carries the workflow): it must show **PASS 171/171, 0 failures, 0 warnings** for `azerdex-assets.pages.dev` and `3ae723a0.azerdex-assets.pages.dev`. A Pages Direct Upload is a **complete snapshot**: any live file missing from the upload would disappear, so any FAIL/WARN = stop.
3. **A3 Rollback target re-confirmed** — Cloudflare dashboard → Workers & Pages → `azerdex-assets` → Deployments: the newest **Production** deployment must be `3ae723a0-df00-4dcd-9159-8ba93d0583aa` (source *Upload*/ad hoc, production branch `main`). If it is anything else (someone deployed since the audit): **stop and tell this session**; the rollback target and the baseline pin must be re-derived. (If the repository secrets `CLOUDFLARE_API_TOKEN` [*Account › Cloudflare Pages › Read* only] and `CLOUDFLARE_ACCOUNT_ID` are added, the same workflow checks this automatically and **fails** on a different ID; without them this one dashboard look is the check.)

**B. Production deployment (explicit approval; one upload)**
Dashboard → Workers & Pages → `azerdex-assets` → Deployments → **Create deployment** → environment **Production**, branch `main` → upload the zip (or its extracted folder) → Deploy. (The exact labels may differ slightly; if the dashboard offers only *Preview*, or asks for a different branch, stop and tell this session.)
The zip has `_headers` at its root, 180 files, largest 300,272 B; it contains the 172 baseline entries byte-for-byte plus 8 `zone-heroes` files. No new project, no DNS or custom-domain change, no `_redirects`, no Functions.

**C. Post-upload verification (this session, right after you say "uploaded")**
`V2-B CDN read-only verification`, mode **Post**, `https://azerdex-assets.pages.dev` → must be **PASS 179/179**: every baseline file unchanged (size + SHA-256, immutable cache), the 8 hero files byte-equal to the inventory, `/zone-heroes/*` served as `image/webp` with `Cache-Control: public, max-age=31536000, immutable`, CORS `*`, nosniff, `Timing-Allow-Origin: *`, unknown paths still 404.
Optionally first verify the new deployment's own unique URL (Cloudflare shows it after the deploy) with the same workflow, before looking at the alias.
**Any FAIL ⇒ roll back immediately (section 5) and report.**

**D. After a PASS**: promote the ledgers (append-only) in a PR prepared by this session (`promote-ledger` / `promote-hero-ledger`), reviewed and merged by you. From then on any change to a published file fails the build; new art ⇒ `v2`.

Optional dry run, if you prefer to see the snapshot before touching production: create the deployment with *Preview* (a non-production branch) — the live production alias is not changed — and run Post mode against its `<hash>.azerdex-assets.pages.dev` URL. This is an extra step, not a requirement.

## 4. Vercel beta activation (separate go-ahead; Preview, branch `web/azerdex-beta` only — never Production)
Preconditions (all met): the Cloudflare deployment is verified (§0); the beta CSP already allows `https://azerdex-assets.pages.dev` in `img-src` (observed); `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` is set on beta (observed via the CSP).
Targets: Vercel team `imemoths-projects` (`team_am1yI4RJ4XBx51uYSrfVm0dr`), project `wow-foreverdb` (`prj_2NOZDdocNiHfZqhnYzxTRTHwxpOQ`). **Pre-activation baseline recorded 2026-10-22:** smoke `expect=local` on `https://beta.azerdex.com` **PASS 32/32** and the probe (5 runs; Cloudflare median total 38–81 ms vs Vercel 67–96 ms per file, informational) — [run 39818568580](https://github.com/Imemoth/wow-foreverdb/actions/runs/39818568580), artifact `v2b-hero-smoke-local` 12442184947.
Nothing below needs a local checkout: the smoke and performance probe run on a GitHub runner via **Actions → "V2-B hero smoke (read-only)" → Run workflow** (`.github/workflows/v2b-hero-smoke.yml`, GET only, evidence artifact), which this session can also start through the API.
1. **Before (rollback-state baseline)** — workflow with `expect = local`, site `https://beta.azerdex.com`: must **PASS** (same-origin heroes `/zones/hero/…`, no `zone-heroes` reference, crop class, strict CSP, all 8 same-origin files = inventory bytes). It also records the Vercel-vs-Cloudflare probe (`probe-local.json`) while still on `local`.
2. **Set the variable** (one variable; server-side only, read per request): name `AZERDEX_ZONE_HERO_SOURCE`, value `cdn`, environment **Preview**, git branch **`web/azerdex-beta`** only. Dashboard: Project `wow-foreverdb` → Settings → Environment Variables → Add (Environments: Preview → branch `web/azerdex-beta`); or this session sets it with the Vercel integration once you say so. **Never** Production or "All preview branches".
3. **Redeploy** the latest `web/azerdex-beta` deployment (Dashboard → Deployments → ⋯ → Redeploy; or this session via the Vercel integration): variables apply to new deployments only. Wait until it is READY and `beta.azerdex.com` points at it.
4. **After** — workflow with `expect = cdn`: must **PASS** per zone (Hillsbrad 1424, Duskwood 1431): HTTP 200; `<source>`/`<img>` `srcset`, `src`, `sizes`, intrinsic size and `fetchpriority=high` exactly as before but on `https://azerdex-assets.pages.dev/zone-heroes/<id>/v1/…`; crop = stylesheet class (`hero-pos-85-50` / `hero-pos-85-45`), no inline style; CSP strict (no `unsafe-inline`), `img-src` = `'self' data:` + the one CDN origin; all 8 hero files fetched with the inventory's exact bytes and immutable / `image/webp` / CORS / nosniff / timing headers.
   Visual check by the owner (desktop and phone): `https://beta.azerdex.com/zone/1424` and `/zone/1431` — DevTools → Network: hero request on `azerdex-assets.pages.dev/zone-heroes/…` status 200; Console: **no** CSP message; crop as approved; the atlas map below the hero loads.
5. **Performance comparison** (protocol in [`zone-hero-performance-baseline.md`](zone-hero-performance-baseline.md) §4): `probe-local.json` (before) vs `probe-cdn.json` (after) from the workflow, repeated at different times; Lighthouse (mobile and desktop, ≥ 5 runs) on both states is the owner/browser-side part. Suggested acceptance: Cloudflare median hero download ≤ same-origin median (warm), LCP not worse than noise (±10 %); otherwise keep `local`. The probe is informational (no thresholds).
6. If anything is wrong → §5.1 (remove the variable, redeploy; one variable, one redeploy).

## 5. Rollback plan
1. **Website (fast, no data involved)**: remove the variable (`npx vercel env rm AZERDEX_ZONE_HERO_SOURCE preview web/azerdex-beta`, or set it to `local`) and redeploy (or use Vercel's instant rollback to the previous deployment). The same-origin files are still in the repository and the app. Verify: `web/scripts/hero-cdn-smoke.mjs --expect local` → PASS.
2. **Cloudflare**: Dashboard → Workers & Pages → `azerdex-assets` → Deployments → the recorded rollback target **`3ae723a0-df00-4dcd-9159-8ba93d0583aa`** (re-confirmed in A3) → ⋯ → *Rollback to this deployment* ([Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/): reverts the project to a previous production deployment). Then this session runs the workflow in mode **Baseline** → must be `PASS 171/171` again (the hero URLs 404 again; the website must be on `local` first, step 1, or its heroes would break). Alternative if the dashboard rollback is unavailable: create a new Production deployment from the original 172-file atlas-dist (the approved baseline zip), then verify as above.
3. **Ledgers**: not promoted before a PASS; if promoted and the deployment was rolled back, revert that commit. Never delete Pages deployments or published files; a wrong hero is fixed with `v2`, not by editing `v1`.
Order for a full back-out: 1 (website) → 2 (Cloudflare) → 3.

## 6. Open items, approvals and limits
1. **Vercel beta activation (§4)** — prepared, not performed; needs the explicit go-ahead. Production Vercel is out of scope.
2. Ledger promotion (§3 D: `promote-ledger`, `promote-hero-ledger`) — not done; it needs its own reviewed PR now that the deployment is verified.
3. The new deployment ID and its Production/`main` placement come from the owner's authenticated Cloudflare API check; this session verified the served content (179/179) but could not read the API (optional read-only secrets would let the workflow check the deployment ID itself).
4. Real-browser decode / CSP / crop of CDN-served heroes — only possible after activation (§4 step 4).
5. **Licensing: the audit, the verification and this record prove file integrity only. They are not licensing clearance.** The eight hero derivatives are owner-approved beta artwork whose public CDN hosting the owner authorised for this pilot; the baseline atlas files are as approved. No private master artwork was uploaded.
6. Windows PowerShell 5.1 was never run; irrelevant under this procedure (PowerShell 7 on the runner; `atlas.py verify-remote` is the Python equivalent).
