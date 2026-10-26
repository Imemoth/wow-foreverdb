# AzerDex website roadmap

Authoritative milestone ledger for the **public AzerDex website** (`web/`), tracked
separately from `docs/ROADMAP.md`'s Addon/Companion/Account System V1 milestones. This
file exists because `docs/ROADMAP.md`'s own "Web — public ForeverDB website" section
predates the AzerDex rebrand and does not mention any of the milestones below — see the
note added there pointing here.

**Status terms used throughout:** `IMPLEMENTED` (code exists, built), `CI VERIFIED`
(the relevant automated checks pass on the stated head), `RUNTIME VERIFIED` (exercised
against a running deployment, not just CI), `OWNER ACCEPTED` (the owner has reviewed and
approved the result), `BLOCKED` (cannot proceed until a named dependency clears),
`PLANNED` (scoped but not started), `HISTORICAL` (a past record, not re-verified here).

**Scope boundary:** every milestone below runs on the `web/azerdex-beta` branch/public
beta track, entirely separate from `main`/`release` Production and from the Account
System V1 / Browser Pairing gates in `docs/ROADMAP.md` and `docs/account-v1/`. Shipping
a milestone here never implies Production readiness, Account Auth activation, or a
public installer release.

## P1 — Brand and homepage foundation

- **Scope:** AzerDex design token system, reusable component library, SiteHeader/Logo/
  Footer rebrand, homepage redesign, Account V1 page restyle, SEO/OG/favicon update,
  original rotating hero artwork (3 themes), homepage "Explore AzerDex" feature cards.
- **State:** `IMPLEMENTED` · `CI VERIFIED` · `OWNER ACCEPTED` (merged to
  `web/azerdex-beta` across several rounds; independently reviewed for UI/UX,
  accessibility and security each round).
- **Dependencies:** none outstanding.

## P2-A — Database and Zones visual refinement

- **Scope:** `CartographyHero` full-bleed cinematic hero pattern, owner-supplied
  "Arcane Archive" (Database) and "Arcane Cartography" (Zones) hero photography,
  illustrated acquisition-method tiles on Database, deterministic zone-medallion
  rotation on Zones/zone-detail, restrained zone-detail polish.
- **PR reference:** [#69](https://github.com/Imemoth/wow-foreverdb/pull/69), merged into
  `web/azerdex-beta` as `bcd2479`.
- **State:** `IMPLEMENTED` · `CI VERIFIED` (full Playwright suite incl. WCAG 2.2 AA
  axe checks) · `RUNTIME VERIFIED` (live public-beta smoke test against
  `beta.azerdex.com` after merge: homepage unchanged, Database/Zones noindex, hero
  photography serving, synthetic-data banner present) · `OWNER ACCEPTED` (owner approved
  the merge).
- **Dependencies:** none outstanding.

## P2-B — Guides / Arcane Library

- **Scope:** Arcane Library landing page, premium guide reader, owner-supplied hero
  photography and medallion icon set, mobile reading-order fix.
- **State:** `IMPLEMENTED` · `CI VERIFIED` · `OWNER ACCEPTED` (merged to
  `web/azerdex-beta`).
- **Dependencies:** none outstanding.

## P2-C — News & Blog

- **Scope:** shared `ArticleHub`/`ArticleReader` hub pattern for News and Blog, original
  inline-SVG hero fallback art, owner-supplied hero photography and featured/spotlight
  card art, tablet header/filter-form fix.
- **State:** `IMPLEMENTED` · `CI VERIFIED` · `OWNER ACCEPTED` (merged to
  `web/azerdex-beta`).
- **Dependencies:** none outstanding.

## P2-D — Interactive Cartography POC

- **Scope:** isolated `/poc/maps/tirisfal` interactive Tirisfal Glades map proof of
  concept (Leaflet `CRS.Simple`), reusing the Companion's normalized-percent coordinate
  model, fixture data only.
- **PR reference:** [#70](https://github.com/Imemoth/wow-foreverdb/pull/70) (Draft, open,
  based on `web/azerdex-beta` at `bcd2479`).
- **State:** `IMPLEMENTED` · `CI VERIFIED` (227 Playwright tests passed at the PR's own
  head) · **`BLOCKED`** — the supplied map image appears to be Blizzard map art, and the
  project's own `maps-and-assets.md` states Blizzard artwork is not redistributed. The PR
  itself says: do not merge to a public branch, deploy, or publish to the CDN until
  licensing is decided.
- **Dependencies:** owner licensing decision on the map image. Tracked, licensed, and
  reviewed **entirely separately** from this document's other milestones — nothing in
  P2-A/B/C/E depends on or is affected by P2-D's outcome.

## P2-E — Addon & Companion Experience (this round)

- **Scope:** premium cinematic `/download` page rebuild — full-bleed owner-supplied hero
  photography with a permanent SVG fallback, in-page section navigation, alternating
  Addon/Companion feature showcases built only from verified repository behavior, a
  typed future-ready screenshot-slot registry (placeholders only, no fabricated
  screenshots), a responsive "How AzerDex works" data-pipeline explainer, a release-gated
  staged installation flow, and an FAQ with a documented (not fabricated) Discord
  placeholder.
- **Working branch:** `web/azerdex-p2e-addon-companion`.
- **State:** `IMPLEMENTED` (this round) · verification results recorded in the round's PR
  description once opened · **not yet `OWNER ACCEPTED`** — a Draft PR is opened against
  `web/azerdex-beta` specifically for owner visual review and is not merged.
- **Explicit non-claims:** this round does **not** activate, enable, or claim
  completion of Account Auth, Browser Pairing, registered-device enrollment, AutoSync, a
  signed public Companion installer, or P2-D. Browser Pairing V1 (Stage B) is
  implemented and internally verified on its own unmerged branch but **not publicly
  activated** — it remains blocked on an unresolved hosting-provider ingress guarantee,
  and Stage C (Companion Connect Account, DPAPI, system-browser launch, the
  AutoSync-stays-OFF invariant, etc.) has not started. No file reachable from
  `web/azerdex-beta` currently documents Browser Pairing; it exists only on the
  unmerged `feature/browser-pairing-v1` branch (PR #62).
- **Dependencies:** none for the page itself. A future round to replace screenshot
  placeholders needs real, reviewed screenshots (see
  `docs/azerdex-download-art/provenance.md` for the drop-in procedure). A future round
  to activate installation step 4 needs a signed, publicly distributed Companion
  installer, which is itself gated on Browser Pairing Stage C and the owner's own
  release process — entirely out of this document's and this round's scope.

## P2-Z — Atlas, public-data pipeline and real-data public beta

- **P2-Z1 — Unified zone atlas & observation maps** ([#78](https://github.com/Imemoth/wow-foreverdb/pull/78), integrated into the beta through #85):
  catalog-driven `/zones`, the shared Leaflet map engine on `/zone/[id]` and source pages, behind `AZERDEX_ZONE_MAPS=1`. `IMPLEMENTED` · `CI VERIFIED`.
- **P2-Z2 — Supabase-native publication pipeline** ([#84](https://github.com/Imemoth/wow-foreverdb/pull/84), integrated through #85): private aggregate export →
  Edge Function `publish-observations` → public Postgres, `pg_cron` every 15 minutes, map-point APIs. Verdict `SUPABASE_NATIVE_PUBLISHER_PASS_WITH_LIMITS`
  (2 s Edge CPU limit at ~25–27× the measured volume). `COMPLETE` for the current data volume.
- **P2-Z3 — Public beta on real published data** (#85, #86, #87, #89; runbook and evidence: [public-beta-release.md](public-beta-release.md)):
  **`COMPLETE` (2026-10-21).** `beta.azerdex.com` serves the genuine published Companion data (publication id advancing through Cron), no synthetic
  fallback, `AZERDEX_READ_DB_URL` server-only/Sensitive, TLS root cause fixed (Supabase Root 2021 CA for pooler hosts only, verification on), CSP fixed for
  Next.js soft navigation, beta homepage SEO policy requires a genuine active publication, owner browser acceptance of artwork/markers/soft navigation.
  - **Non-blocking items carried forward:** map calibration stays `provisional`; artwork licensing review pending (see P2-D); Vercel Git auto-deployment
    anomaly after the #89 merge (cause not established); dashboard-only housekeeping (retired `diag-db-host` function, Data API).
  - **Not closed by this milestone:** P2-D licensing, Production activation (`FOREVERDB_DEPLOYMENT=production`), the Account/Companion work (e.g. #88), and
    the stacked Draft PRs #70/#72/#77/#78/#84 (intentionally left open).

## P3 — Site-wide release polish and future scope

- **Scope:** not yet defined. Candidates noted informally across prior rounds include a
  broader Lighthouse/performance pass, a real screenshot pass for P2-E's media slots once
  available, and whatever the owner scopes once P2-D's licensing question resolves.
- **State:** `PLANNED` (unscoped).
- **Dependencies:** none of the above P1/P2 milestones block starting P3 scoping; P2-D's
  licensing outcome may inform (but does not block) it.
