# Cinematic zone hero — performance baseline (for the later Vercel-vs-Cloudflare comparison)

Status: baseline **recorded locally**; **no network numbers exist yet**. The preparation sandbox cannot reach `*.pages.dev` or the Vercel beta (proxy `CONNECT 403`), so nothing below
says anything about real latency. What is fixed here: the exact bytes, the rendition each viewport picks, the rendering cost on loopback, and a protocol + probe to collect the real numbers.
Context: [`unified-cdn-v2a.md`](unified-cdn-v2a.md) (the same eight files are served either same-origin by Vercel or from the Cloudflare Pages `zone-heroes/` namespace).

## 1. Payload (identical for both origins — the files are byte-for-byte the same)
| Zone | File (CDN name) | Same-origin name | Size | Bytes |
| --- | --- | --- | --- | ---: |
| 1424 | `desktop-1280.webp` | `1424-hillsbrad-foothills-1280.webp` | 1280×427 | 56,890 |
| 1424 | `desktop-2000.webp` | `…-2000.webp` | 2000×667 | 103,602 |
| 1424 | `mobile-600.webp` | `…-mobile-600.webp` | 600×323 | 30,614 |
| 1424 | `mobile-900.webp` | `…-mobile-900.webp` | 900×484 | 57,650 |
| 1431 | `desktop-1280.webp` | `1431-duskwood-1280.webp` | 1280×548 | 63,462 |
| 1431 | `desktop-1916.webp` | `…-1916.webp` | 1916×821 | 112,782 |
| 1431 | `mobile-600.webp` | `…-mobile-600.webp` | 600×515 | 45,462 |
| 1431 | `mobile-900.webp` | `…-mobile-900.webp` | 900×773 | 83,146 |

Total 553,608 bytes for the eight; a visitor downloads exactly one hero image (`<picture>` + `srcset`). `fetchpriority="high"`, intrinsic `width`/`height` (no layout shift), no lazy loading.

## 2. Which rendition is requested (measured in Chromium, both modes)
| Viewport | DPR | Hillsbrad (1424) | Duskwood (1431) |
| --- | --- | --- | --- |
| Desktop 1366×900 | 1 | `desktop-1280` (56,890 B) | `desktop-1280` (63,462 B) |
| Pixel 7 412×839 | 2.625 | `mobile-900` (57,650 B) | `mobile-900` (83,146 B) |

(`sizes="(min-width: 1280px) 1232px, 100vw"` ⇒ a 1366 px / DPR 1 screen needs ≤ 1232 px → the 1280 w file; DPR ≥ 2 or very wide screens get the 2000/1916 w file; phones < 640 px use the separately cropped mobile files.)

## 3. Local baseline (Playwright/Chromium on loopback — rendering cost, **not** network)
Recorded by `tests/zone-maps/hero-perf-baseline.spec.ts` (JSON per run in `web/test-results/hero-perf-<source>-<project>-<zone>.json`). Single runs on a shared CI-class sandbox are noisy (±100 ms; the first request after server start is slower): treat as order of magnitude only.

| Source | Viewport / zone | Hero LCP candidate | LCP | Hero `encodedBodySize` | Hero resource duration |
| --- | --- | --- | ---: | ---: | ---: |
| same-origin | desktop / 1424 | hero image (`…-1280.webp`) | 276 ms | 56,890 | 25 ms |
| same-origin | desktop / 1431 | hero image | 316 ms | 63,462 | 42 ms |
| same-origin | mobile / 1424 | hero image (`…-mobile-900.webp`) | 236 ms | 57,650 | 27 ms |
| same-origin | mobile / 1431 | hero image | 244 ms | 83,146 | 24 ms |
| CDN stand-in | desktop / 1424 | hero image (`desktop-1280.webp`) | 604 ms (cold server) | 56,890 | 41 ms |
| CDN stand-in | desktop / 1431 | hero image | 280 ms | 63,462 | 28 ms |
| CDN stand-in | mobile / 1424 | hero image (`mobile-900.webp`) | 264 ms | 57,650 | 37 ms |
| CDN stand-in | mobile / 1431 | hero image | 344 ms | 83,146 | 66 ms |

What this establishes: the hero image **is** the LCP element in both modes; the CDN delivery changes neither the chosen rendition, the bytes, the markup nor the LCP element; cross-origin Resource Timing reports real sizes
because `Timing-Allow-Origin: *` is part of the new `_headers` rule (without it `encodedBodySize` would be 0 for the CDN request and the comparison impossible).

## 4. Protocol for the real comparison (run later, from machines that can reach both origins)
Prerequisite: the unified snapshot is uploaded and verified (`verify-remote`), and a **Preview** deployment with `AZERDEX_ZONE_HERO_SOURCE=cdn` exists next to the unchanged same-origin beta. Compare like with like: same files, same page, same time window.

1. **Raw asset delivery** (isolates the CDN from the app): `node web/scripts/hero-perf-probe.mjs --vercel https://beta.azerdex.com --cloudflare https://azerdex-assets.pages.dev --runs 10 --out probe.json`
   — per file and origin: status/bytes check, first-request and median TTFB / total time, `Cache-Control`, `Age`, `x-vercel-cache` / `cf-cache-status`. Run from ≥ 3 regions (e.g. EU, US-East, Asia) and at ≥ 2 times of day; keep the first request of a series (cold edge) and the median (warm) separately.
2. **Page-level** (what a visitor feels): Lighthouse/WebPageTest, mobile profile (Moto G-class, "4G") and desktop (cable), `/zone/1424` and `/zone/1431`, ≥ 5 runs each, first view and repeat view, for both deployments: LCP (must be the hero image), hero request start→end, TTFB of the HTML (unchanged by this work), total bytes, request count (must be equal), connection cost of the extra origin (DNS+TCP+TLS of `azerdex-assets.pages.dev` on first view — the one unavoidable cost of a second origin; `<link rel="preconnect">` is **not** added in V2-A).
3. **Playwright metrics** against the deployed Preview: `E2E`-style run of `hero-perf-baseline.spec.ts` logic (LCP entry, resource timing with TAO).
4. **Record** per run: date/time, region, network profile, deployment URLs/commit, HTTP protocol (h2/h3), `server`/edge headers, cache state.
5. **Decision inputs** (not thresholds decided here): median/p75 LCP and hero download time per region and network profile, cold vs warm edge, first-view connection overhead, consistency (p95 − p50), plus cost/ops (both free today; Vercel bandwidth/Image budget vs Pages free static assets).

## 5. Not measured / caveats
No real-network data; no Vercel or Cloudflare cache behaviour; no HTTP/3; loopback timings include Next.js server-side rendering time in the TTFB; the Playwright desktop profile is DPR 1 (a DPR-2 desktop would fetch the 2000/1916 w file: 103,602 / 112,782 B). Comparing LCP across origins also depends on connection reuse, which only the real-network run shows.
