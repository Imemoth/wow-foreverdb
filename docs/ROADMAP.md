# ForeverDB Roadmap

ForeverDB is developed in small, testable milestones. The roadmap is intentionally
ordered so that data correctness and WoW-client compatibility stay ahead of
polish and distribution work.

## Account V1 — owner-approved single-installation claim pilot (PR #55, draft)

- [x] Owner approved lifting the existing single-project Companion claim-code restriction, scoped to a private pilot (2026-10-12).
- [x] PR #55 draft on PR #54: a separate private-claim-pilot process mode accepts ONE explicitly selected installation ID; default production and login-only modes remain unchanged.
- [x] The original anonymous DPAPI credential is only read and copied into an isolated legacy slot; refresh and revocation of the copy are blocked. Code issuance requires live server proof of anonymous ownership. Full ingest, automatic sync, owner selection and new anonymous identity creation remain blocked.
- [x] Website password-confirmed one-time code redeemed successfully on 2026-10-13 for owner-approved historical installation `2f8df8ba69345d0a14c8d56ac86d4b2e`; one claim consumed and one registered ownership link confirmed by read-only production SQL. No migration or unrelated owner transfer executed.
- [x] Prior PR #55 pilot build at `f0ea09f` passed Windows account auth tests, CodeQL and GitHub CI; owner-run claim success verified on that installed build.
- [ ] Independent release-oriented code/security review and CI on the FINAL revised PR head, including negative cases; do not merge draft PR with temporary private-pilot source flags enabled.
- [x] Owner accepted using one existing historical installation instead of provisioning a disposable one (2026-10-12). Read-only Supabase inspection confirms scoped ID `2f8df8ba69345d0a14c8d56ac86d4b2e` is anonymously owned, with 140 source-stat rows and 46 Guildbook-member rows.
- [x] Pre-claim baseline read-only verified (0 links/claims, exact target anonymously owned, 140 source rows/46 members, other-six ownership fingerprint `1bd16ed087b98f0632b5f01a39c760ba`); post-claim other-six fingerprint unchanged.
- [x] Windows/web owner transfer E2E: initial credential-unavailable recovery followed by successful one-time code issue and protected web redemption; live SQL confirms 1 registered link, consumed claim, 140 source-stat rows and 46 member rows retained, six other owners unchanged (2026-10-13).
- [ ] Finish owner-run **Your installations** + **Private Guildbook** UI/RLS verification and Companion post-transfer `Check status` (no Sync now). Registered snapshot ingest/AutoSync remains disabled; old anonymous ingest to the transferred installation must not be retried.
- [ ] Only after explicit review and acceptance, design protected post-claim registered snapshot ingestion. Keep all public pilot flags OFF for main/release.

Runbook: [private claim pilot](account-v1/private-claim-pilot.md).

## Companion — registered sign-in for existing private Supabase (PR #54, draft)

- [x] Owner explicitly approved lifting the blanket existing-project registration ban **for a private Companion pilot only** (2026-10-12).
- [x] Draft PR [#54](https://github.com/Imemoth/wow-foreverdb/pull/54) (base: draft PR #53): `FOREVERDB_ACCOUNT_MODE=private-pilot` exact-host connection, separate DPAPI test vault, **registered sign-in/sign-out enabled**. The public production flag stays OFF, and default anonymous Companion is unchanged.
- [x] Pilot code disables anonymous account creation, claim-code generation, snapshot ingest, owner selection, and automatic post-login sync at multiple independent layers. No live ownership data changed.
- [ ] Windows Companion CI and independent safety review on the final PR #54 head.
- [ ] Owner-run isolated-vault login/logout/refresh verification, original credential hash check, and read-only Supabase preservation baseline; **W1a, W4 and W7/W8 are not yet accepted**.
- [ ] Before any merge/distribution, revert the temporary `PrivateProjectPilotApproved=true` source flag to `false` and rerun CI; keep public `ProductionAccountAuthApproved=false`.
- [ ] Separately review and explicitly approve **throwaway-installation** claim/ingest support only after the login-only pilot passes, never with one of the 7 valuable historical installations first.

Runbook: [Private project Companion pilot](account-v1/private-project-companion-pilot.md).

## Account V1 — single existing Supabase project candidate (2026-10-12)

- [x] Separate code-only branch for a **protected, owner-only account pilot** using the existing private Supabase Auth project and for eventual production-compatible Auth configuration.
- [x] Owner-authorized guarded Preview **pilot flag temporarily ON in draft PR #53** (`SINGLE_PROJECT_PILOT_APPROVED = true`); public production flag remains OFF. **The account is now ACTIVE only in the SSO-protected branch Preview**: verified account creation, confirmation email received in Gmail Inbox, account profile, sign-out and fresh password sign-in (2026-10-12). **Before merge, revert pilot flag to false and rerun CI.**
- [x] Scoped Auth-only publishable-key boundary and fail-closed pilot/production configuration matrix; public data isolation unchanged.
- [ ] CI on final PR head and independent security review (no merge or deployment until approved).
- [x] Existing private Supabase `0012_account_ownership_claims` applied (2026-10-12) after owner-led local archive check; all 9 functions and 3 RLS-protected tables verified, ledger recorded, pre-existing installation and Guildbook hashes unchanged.
- [ ] Owner-run hosted abuse, email/DMARC, Auth URL, **migration recovery rehearsal**, remaining Windows and cross-account acceptance.
- [x] Owner authorized and activated an SSO-protected personal **Preview pilot** against the existing private Supabase Auth instance; URL/confirmation template and all five branch-scoped Auth Vercel variables configured. **Owner runtime registration/email confirmation/log out/new login: PASS (2026-10-12)**; 7 previous installations and 46 Guildbook member records remain unchanged, and no installation has been linked. Hosted password reset, session refresh, account isolation, claim/ownership transfer and direct-GoTrue-abuse gates remain OPEN.
- [ ] **Account profile — Last sign-in (near-term enhancement):** show the most recent successful sign-in from the server-verified Supabase Auth `last_sign_in_at` field (already in the AccountUser contract). Format an unambiguous date, clock time and timezone (Hungary / Europe/Budapest, with DST respected); support missing timestamps; never trust a client-provided date or show another user's metadata. Add UI and formatter tests. Does not require a new database table.
- [ ] **Account security — Recent sign-ins (later milestone):** provide a bounded, per-account history of successful sign-ins, and consider current/other-session overview and revocation only after dedicated design. Investigate Supabase Auth audit/session retention first; collect the minimum necessary metadata, define retention/deletion and timezone rules, protect all reads server-side with verified user/session ownership and RLS/least privilege, exclude raw IPs/tokens from UI, and test multi-account isolation and session invalidation. **No new production tables or cross-account API exposure during the current pilot.**
- [ ] Separate explicit approval and independent security gate for any public production activation.
- See [single-project candidate runbook](account-v1/single-project-candidate.md) and [Issue #52](https://github.com/Imemoth/wow-foreverdb/issues/52). Prior isolated-staging runbook remains an available safer alternative.

## Current baseline

### Addon
- Version: **0.5.0-alpha**
- Schema: **9**
- Forever interface: **16001**
- Observed pipelines:
  - mob loot
  - skinning
  - mining
  - fishing
  - fishing pools
  - chest / GameObject
- Experimental / pending E2E:
  - herbalism
  - disenchant
- In-game Session Tracker (XP/hour, gold, active-time rates, compact HUD,
  detailed window): repo-complete; live Forever acceptance **PASS**.

### Companion
- Version: **0.9.0-alpha** (Account System V1 authentication; account features OFF by default, production blocked)
- Authenticated Supabase sync
- Item/source search and detail navigation
- Multi-zone location browsing
- Native Forever map rendering from WoW CASC FileDataIDs
- Local-first CASC with exact-build Blizzard CDN fallback for streamed tiles
- Marker / cluster / heatmap overlays
- Persistent map metadata, resolution and PNG caches
- Sanitized map-resolution diagnostics
- Background map pre-warming for recently synced zones

Map asset pipeline acceptance status:
- Tirisfal Glades: PASS, 12/12 tiles
- Silverpine Forest: PASS, 12/12 tiles
- Validated product/source: `wow_classic_beta` / FileDataID

## 0.5.0-alpha — Session Tracker

Implementation status: **repo-complete reconfirmed as of `bfe0e75`**
(external review round 2's findings, independent Reviewer C's follow-up
findings, a UI/UX-only polish round's independent Reviewer D pass, a
dimensioned-spec + live-scrollbar-bug-fix round's independent Reviewer F
pass, a live-client layout-fix round (Session Timing, Character panel
order, Recent Sessions columns), a micro-polish round (XP bar spacing,
Recent Sessions Net-Gold-only) with a mandatory independent Reviewer G
gate, and an icon-pack-integration round (7 local addon-packaged TGA
icons) with a mandatory independent Reviewer H gate — all PASS, zero
blocking findings — are all fixed where applicable and repo-side
re-verified). **Live Forever-client acceptance: PASS** (human tester,
full checklist — see the acceptance ledger's "Live Forever acceptance"
section). See also "Review round 2", "Review round 3 (UI/UX polish)",
"Review round 4 (dimensioned spec + scrollbar fix)", "Round 5
(live-client layout fixes)", "Round 6 (XP bar spacing + Net Gold only,
Reviewer G gate)", "Round 7 (icon pack integration, Reviewer H gate)",
and "Verification snapshot" sections.

Goal: give players useful in-game leveling/farming feedback (XP/hour, time
to level, gold earned/spent/net, active-time-based rates) without requiring
the Companion, addon-only for V1.

- [x] Per-character session lifecycle: automatic start/resume, configurable
      offline timeout (default 60m), reload/relog re-baselining without
      backfill.
- [x] Manual pause/resume/reset; reset requires confirmation from both the
      detailed window and `/fdb session reset`.
- [x] XP accounting resilient to `PLAYER_XP_UPDATE`/`PLAYER_LEVEL_UP`
      event-order variance, with the canonical level-up wrap formula.
- [x] Integer-copper gold accounting (earned/spent/net) from `GetMoney()`.
- [x] Active-time-based rates with a configurable inactivity cutoff
      (default 5m); active time never backfills an idle gap.
- [x] Up to 30 retained completed sessions per character; short/empty
      sessions discarded.
- [x] Compact WoW-native HUD (movable, lockable, position/visibility
      persisted per character) and a detailed `/fdb session` window with
      KPI/timing/character/rates/history panels.
- [x] `/fdb session [pause|resume|reset|hud|lock|timeout <min>|idle <min>]`,
      calling the same tracker/UI APIs as their button equivalents.
- [x] Session state is local-only (`ForeverDB_Saved.sessions`); export
      schema remains **9** and `ForeverDB_Export` carries no session data.
- [x] Simulated Lua smoke coverage (`tests/session_tracker_smoke.lua`,
      `tests/session_ui_smoke.lua`) and CI compile/test steps.
- [x] Live Forever client acceptance — **PASS**, see the checklist in
      the acceptance ledger below.

Repo-side verification and the live-acceptance checklist:
[0.5 Session Tracker acceptance](0.5-session-tracker-acceptance.md).

## 0.7.0-alpha — Map UX & location intelligence

Implementation status: **complete; current-build runtime acceptance in progress.**

Goal: turn the working map renderer into a practical Gatherer/Wowhead-style
location browser.

- [x] Selecting a location row switches the map to that row's zone.
- [x] Preserve all zones for a detail result instead of silently showing only the
      highest-observation zone.
- [x] Make the current map/zone selection obvious in the Locations UI.
- [x] Improve marker tooltips with area, coordinates, acquisition kind and sample.
- [x] Improve cluster tooltips with unique-node and observation counts.
- [x] Reset breadcrumb/history when the user starts from a new search result.
- [x] Hide synthetic fishing-pool IDs from normal UI.
- [x] Label synthetic fishing-pool GameObjects as Fishing Pool instead of Object.
- [x] Pre-warm map art for recently synced zones in the background.
- [x] Keep first-load work deduplicated and all subsequent map loads cache-first.

Acceptance:
- one item/source may be browsed across multiple zones without reopening Search;
- selecting a different zone/location changes the map correctly;
- normal map revisit is effectively instant from cache;
- navigation breadcrumb contains only the active navigation chain.

Current acceptance procedure: [0.7 acceptance test](0.7-acceptance-test.md).

### 0.7.1-alpha — UI polish

- [x] Keep selected DataGrid rows readable after keyboard focus moves to the map.
- [x] Prevent map toolbar / zoom text clipping at narrower widths.
- [x] Replace raw location acquisition keys with user-facing labels.

### 0.7.2-alpha — Search & map usability (planned)

- [x] Add an area/zone selector to Companion Search so results can be scoped to a
      chosen zone instead of relying only on the currently-observed location set.
      **Repo/backend + Windows/WPF runtime acceptance PASS (2026-10-07):** selector
      is populated from observed zones, defaults to `All zones`, preserves name/ID
      search, and scopes only the result list so existing multi-zone
      detail/navigation and map overlays remain unchanged. Live follow-up also
      verified automatic re-search on zone change and clearing stale detail/
      navigation state when the new scope returns zero results.
      **Historical note:** that original 2026-10-07 zero-result reset
      behavior was superseded by PR #21's navigation-preserving zone
      refresh after the 2026-10-08 live Back/Forward regression; its
      post-fix Windows acceptance is separately pending.
- [x] Prevent cyclic item/source detail drilldowns from creating
      unbounded repeated breadcrumbs (e.g. Peacebloom item ↔ Peacebloom
      object, Copper Ore → Copper Vein → Shadowgem → Copper Vein).
      **PR #21 CODE/CI + Windows visual PASS (2026-10-09).**
      Search-zone suite **63/63 assertions PASS**, including 21
      new cycle/history checks. Real Windows screenshots show
      `Copper Ore › Copper Vein › Shadowgem` collapsing back to
      `Copper Ore › Copper Vein`, with Forward enabled. A separate
      `Poor Copper Vein` still creates a legitimate new step.
      A Mulgore detail also survives switching the Search zone to
      Silverpine. **Rapid switching / async response race stress
      remains OPEN**, as does direct manual Forward-click acceptance.
      See [acceptance §14](0.7-acceptance-test.md).
- [ ] Browse already observed database items and sources by selecting
      **one zone with an empty Search box**, without requiring a query word.
      **PR #21 implementation ready, release gate OPEN (2026-10-09):**
      new `0008_zone_catalog_browse.sql` authenticated-only RPC serves
      exact observed `map_id + zone_name` entities with stable ordering,
      total count and **50 per page**, plus a Companion `Load 50 more`
      control. All zones + blank query does not enumerate the database;
      name/ID search and detail/Back/Forward are preserved.
      Windows Companion CI and portable pagination/security-token
      regressions PASS. **Migration 0008 APPLIED to production on 2026-10-09** (ledger
      `20261009072627`); SQL privileges and read-only catalog smoke PASS.
      **2026-10-09 live Windows catalog browse PASS:** Mulgore
      **35/35**, Silverpine **20/20** and Tirisfal **215/215**
      after repeated `Load 50 more` clicks. First-page 50/215
      and final 215/215 both confirmed; item and creature details
      can be opened. Precise duplicate-free record audit,
      rapid cross-zone Back/Forward and actual HTTP/JWT security
      tests remain OPEN before merge/release.
      See [zone-only database browse contract](0.7-zone-only-database-browse.md).
- [ ] Prefer a fully revealed zone map in the Companion over fog-of-war/partially
      revealed map variants, while keeping exact-build/local-CASC resolution and
      the existing Blizzard-CDN fallback rules.
      **PR #21 (2026-10-08; Windows visual acceptance OPEN):** full map =
      native base art + all exploration overlays; no separate MapArtID.
      The embedded atlas has 84 maps, 1,073 regions and 1,739 texture IDs.
      Source build 1.60.1.70009 (Map Tab, MIT) was independently compared
      against the 1.60.1.70245 wago.tools-derived overlay catalog:
      **all 84 maps and all region/texture records identical (0 differences).**
      The user's manual screenshots exposed the previous strict single-build
      gate (active 1.60.1.70245 vs atlas 1.60.1.70009). Those **two
      manually verified builds remain the offline fast path**; later
      versions now use the separate strict Auto Atlas Verification flow
      described below. The CASC -> exact-build CDN, transactional base
      fallback and variant-isolated caches remain in force. **Windows Companion CI with the 70245 allowlist
      and new regressions: PASS** (code commit `c74d819`, run `37817201593`);
      collector smoke also PASS (`37817201541`). Older screenshots are
      evidence of a blocked build gate, not a client texture failure.
      **Live Windows screenshot sub-gate PASS (2026-10-08):** Tirisfal
      (MapArtID 2126), Mulgore (1200) and Silverpine (2158) each show
      `cached · full-overlays-verified-70009-70245-v2` with previously
      hidden geography revealed and mining/herbalism/fishing-pool markers.
      The build-mismatch/base-only failure is resolved. Live Clusters and
      Heatmap screenshots **PASS** for Tirisfal/Mulgore, including 63% zoom.
      **Fresh Mulgore `Retry map`: PASS** (12/12 base tiles,
      `FileDataID+full-reveal:18`, non-cached Windows status). Same-query
      item↔source detail Back/Forward also works. **Zone change bug found:**
      changing the zone selector resets the selected result, detail and
      Back/Forward. PR #21 now contains a focused fix to preserve selection,
      detail and history during automatic zone-scoped result refresh, with
      portable identity regressions and Windows CI PASS; **real Windows
      retest still OPEN**. Tooltip/coordinate accuracy and live missing-art
      fallback remain separately unverified.
      See [full-map art investigation and acceptance](0.7-full-map-art-investigation.md).
- [ ] Auto Atlas Verification for future WoW Forever builds.
      **PR #21 repo-side implementation + Windows CI PASS (2026-10-09).**
      Detect the active Forever beta Version + Build Key; fetch the four
      exact-version public DB2 CSVs (WorldMapOverlay/Tile, UiMapArt,
      UiMapArtStyleLayer); strictly compare every map region/offset/tile
      ID against the embedded source atlas; admit **only matching map arts**.
      Proofs are cached locally by hashed product/version/build key/atlas
      identity (14 days), with an 18-second network timeout and 15-minute
      retry for failures. No blind 1.60.* approval; offline/invalid/mismatched
      source -> base map with reason. Previously reviewed builds need no
      network fetch. The GitHub Windows runner fetched exact-version
      DB2 exports and matched **84/84 embedded map arts** for the
      new 1.60.1.70291 build (CI `37906377015`; map tests
      **48/48 PASS**). **70291 real Windows three-zone full-map VISUAL
      PASS (2026-10-09):** Tirisfal **#2126** cold `12/12` base
      tiles and `FileDataID+full-reveal:22 · Auto Atlas VERIFIED
      (1.60.1.70291)`, plus verified warm cache; Mulgore **#1200**
      (Prairie Stalker) and Silverpine **#2158** (Light Leather)
      display fully revealed, cached `full-auto-verified-...`
      map art and location markers. Earlier Silverpine-filtered
      Light Leather detail was focused on Tirisfal #2126; new
      screenshot explicitly proves Silverpine #2158.
      **Still OPEN:** new-build Retry map, noncached CASC composition
      specifically for Mulgore/Silverpine, tooltip/pixel precision,
      rapid zone-navigation history and safe failure fallback.
      Three-zone visual PASS does not imply a global runtime/release PASS.
      [Full verification design / test gate](0.7-auto-atlas-verification.md).
- [ ] Preserve marker / cluster / heatmap overlays and current location navigation
      behavior when changing the underlying map-art variant.

## 0.7.x — Collector coverage closure

- [x] Herbalism / Disenchant repo-side acceptance preparation: tracker review,
      debug breadcrumbs and simulated Lua contract checks.
- [ ] Herbalism E2E test and fixes — **live capture, Auto Loot, reload/full-exit persistence, interrupted-gather isolation, Companion search/details and Mulgore map-location path PASS. Partial-loot/reopen duplicate was reproduced live (Earthroot 1619, H 22->23->24) and fixed repo-side with full-GameObject-GUID dedup; live post-fix retest, repeated-sync no-double-count and direct disk inspection remain pending**.
- [ ] Disenchant E2E test and fixes — **live Combined Backpack test reached Disenchant success/loot but input target capture failed (`succeeded without captured target`, unresolved loot). Repo fixes now add the item-target cursor + ITEM_LOCK_CHANGED fallback and clear spell-ID-less item-target candidates on cursor end or non-Disenchant player spell completion, preventing stale enchant targets from leaking into a later Disenchant. Combined Backpack and stale-target simulated regressions PASS; live post-fix retest required**.
- [ ] Open-water fishing regression test.
- [ ] Chest/GameObject location regression test.
- [ ] Fishing-pool coordinate accuracy review and calibration.
- [ ] Validate map metadata across additional Eastern Kingdoms / Kalimdor zones.

Procedure and evidence ledger: [beta collector acceptance](BETA_TEST_PLAN.md#07x-herbalism--disenchant-collector-acceptance).
Repo preparation is not E2E acceptance: both collectors still require real
addon -> SavedVariables -> Companion -> Supabase -> search/details evidence.

## Future — Quest intelligence & field data

Goal: evolve ForeverDB from source/location tracking into a character-aware quest
assistant without assuming Retail-only quest APIs on the Forever client.

- [x] Add a read-only quest API capability probe (`/fdb questapi`, alias
      `/fdb quests`) that reports modern/legacy API availability, current quest-log
      rows/objectives and completed-quest enumeration capability. **Live Forever
      runtime probe PASS on 2026-10-02:** modern `C_QuestLog` path available,
      active objectives readable and 97 completed quest IDs enumerated.
- [ ] Per-character Quest Tracker for accepted / active / ready-to-turn-in /
      completed / turned-in / abandoned states.
- [ ] Track quest objective progress and completion transitions.
- [ ] Record accept / objective-complete / turn-in zone, subzone and coordinates
      where the client exposes enough context to do so safely.
- [ ] Maintain per-character completed quest history without changing the public
      source/export contract until the quest data model is explicitly versioned.
- [ ] Build a zone quest catalog so ForeverDB can answer "which quests exist in this
      area?" rather than only "which quests are currently in my quest log?".
- [ ] Add zone completion summaries (for example completed / active / remaining)
      once the catalog and prerequisite rules are trustworthy.
- [ ] Add a Companion quest browser with zone and status filters.
- [ ] Model quest chains / prerequisites / faction / level gates before labeling a
      quest as actually available to the current character.
- [ ] Quest auto-accept / auto-complete convenience flow — requirements and safety
      rules to be specified later before implementation.
- [ ] Log world position for quest items obtained from non-mob world loot sources
      (for example containers/GameObjects or other interactable world objects),
      so the item can later be mapped back to where it was actually collected.
- [ ] Define the data contract that distinguishes quest-item world-loot observations
      from mob drops, normal chest/GameObject loot, and quest reward records before
      adding them to search/map presentation.
- [ ] Add quest objective locations from ForeverDB observations (mob drops,
      GameObjects/world loot and other proven sources).
- [ ] Capture / resolve quest giver and turn-in NPC locations where the client/API
      provides reliable identifiers and coordinates.

## 0.8.0-alpha — Guildbook V1

Implementation status: **complete; runtime acceptance PASS.**

- [x] Schema 9 addon Guildbook collector.
- [x] Roster capture with name, GUID, class, level, rank, online state, zone and last-online age.
- [x] Guild-visible primary profession capture.
- [x] Current-character secondary profession capture.
- [x] Export/parser model for Guildbook records.
- [x] Private Supabase per-installation Guildbook tables and authenticated ingest.
- [x] Companion Guildbook tab with filtering.
- [x] Recipe/crafter lookup explicitly deferred because the current Forever build is runtime-limited.

Acceptance: **PASS** — see [0.8 Guildbook acceptance](0.8-guildbook-acceptance.md).

Validated runtime snapshot: 1 guild, 12 members, 4 online, 9 profession rows.

### 0.8.1-alpha — Guildbook polish

- [x] Dark-theme guild/profession ComboBoxes.
- [x] Filter placeholder text.
- [x] Online-only toggle.
- [x] Profession-specific filter.
- [x] WoW class colors in the roster.
- [x] Wrapped profession chips for denser/readable display.
- [x] Addon Guildbook refresh every 30 minutes while logged in.
- [x] Companion status explains the difference between in-client refresh and SavedVariables/Supabase persistence.

### 0.8.2-alpha — Guildbook visual polish

Implementation status: **complete; repo/build verification and manual Windows/WPF visual acceptance PASS (2026-10-07).**

- [x] Increase Guildbook roster row/header spacing for large displays.
- [x] Add compact Members / Online / Offline / 30m refresh summary cards.
- [x] Preserve visible/total counts while filters are active, including active-filter
      all-match and zero-result edge cases.
- [x] Increase primary vs secondary profession chip contrast.
- [x] Add deterministic Companion regression coverage for Guildbook text,
      profession and online-only filtering plus visible/total counter semantics.

Acceptance evidence: [0.8 Guildbook acceptance](0.8-guildbook-acceptance.md).

## 0.8 — Companion hardening & distribution

- [ ] Settings polish and cache management.
- [x] Sync-health/status panel — real auto-sync/watcher/config/auth readiness, last successful sync counts/time, sanitized last error, and visible sync trigger provenance. **Live runtime PASS (2026-10-02):** Manual sync reports `via Manual`; Auto Sync ON reports `via Auto` after reload/relog/logout; Auto Sync OFF suppresses watcher sync while manual sync remains available.
- [ ] Diagnostic controls and retention policy.
- [ ] Installer validation.
- [ ] Startup/tray behavior final pass.
- [ ] Code-signing plan.
- [ ] Auto-update design.
- [ ] Remove obsolete legacy sync scripts/config after compatibility cleanup.
- [x] Restrict legacy public stats view: **2026-10-08 production SQL migration and role-restriction tests PASS; existing Companion runtime acceptance PASS (user-reported)**. `database/migrations/0007_restrict_legacy_public_stats.sql` revokes direct SELECT from `PUBLIC`, `anon`, and `authenticated`; `service_role` is preserved. Live SQL role impersonation confirmed direct SELECT denied for both roles while Search, Stats, Locations and authenticated Sync RPC grants remain correct. The same catalog/aggregate counts were verified before and after deployment. The Windows Companion tester confirmed Search, zone filter, Stats, map/Locations and Manual Sync continue working. See [production cutover and acceptance ledger](legacy-stats-prod-cutover.md). No new external/public API was published.
- [ ] Run separate actual HTTP PostgREST smoke checks with `anon` API key **and** anonymous Supabase Auth JWT: both must be denied direct `/rest/v1/observed_loot_stats` SELECT, while supported Search/Stats/Locations RPCs remain usable. **OPEN: transport-level HTTP/JWT checks were not executed; SQL role-impersonation and Companion manual acceptance are not a substitute for a documented HTTP response.**

- [x] Production API lockdown and quota foundation — **0009 migration deployed on 2026-10-09** (`20261009124630 api_security_rate_limits`). Anon/publishable-key-only reads, stats and ingest denied; current Companion uses anonymous Supabase Auth JWT; Search/Stats/Locations/catalog RPCs and ingest remain available to authenticated sessions. Production SQL grants, bounded RPCs and **PT429 on the 21st catalog request** PASS in rollback-only synthetic-UID tests. The supported-client policy is **latest Companion only**; older key-only clients are intentionally unsupported. Real post-lockdown external HTTPS smoke and updated Companion Manual Sync/Guildbook checks are separate release acceptance. [API security hardening](0.8-api-security-hardening.md).
- [ ] **Registered-account quota tier and reserved capacity** (future): retain today's anonymous JWT budgets; after true account registration/login is implemented, grant a larger per-registered-user budget plus a separately reserved fair-share request pool. Verify ownership/entitlement in Supabase before allocating privileged capacity, preserve private Guildbook RLS/account boundaries, and protect against account-multiplication abuse. **Not in 0009; no higher tier enabled today.**
- [ ] Post-0009 production HTTP+Windows acceptance: **live external HTTPS/anon-vs-JWT boundary PASS** ([run 37933319217](https://github.com/Imemoth/wow-foreverdb/actions/runs/37933319217)); key-only RPCs 401, JWT auth/search/catalog 200, direct raw reads 403. **Real production SQL quota 20/21 PT429 and oversized ingest PT413 PASS in rolled-back synthetic-UID checks.** Still OPEN: newest Companion **Manual Sync/Guildbook** confirmation after cutover and safe error message UX; no destructive/sustained production HTTP rate load test was performed. See [security cutover ledger](0.8-api-security-hardening.md).

### Account login, sessions and private data access — planned

Requested 2026-10-09. **Status: PLANNED; not implemented or runtime-accepted.**
Goal: introduce an explicit ForeverDB user account and use its verified identity
to authorize Guildbook and future private queries. The existing automatic
anonymous Auth session is a technical sync identity, not this account-login feature.

- [ ] Define the account sign-up/sign-in/recovery flow and login provider before
      implementation; distinguish the ForeverDB account from WoW characters and
      the game account. Do not collect game-account passwords.
- [ ] Implement visible signed-in/signed-out state, secure session storage,
      session restore/refresh, expiry handling and logout. An expired or invalid
      session must not silently regain private access through anonymous fallback.
- [ ] Define verified account ownership of installations and their collected
      data, including multiple devices/characters belonging to the same account.
      Prepare a safe migration/linking path for existing anonymous installations
      that preserves observations; knowing an installation ID alone is not proof
      of ownership.
- [ ] Require explicit account login for Guildbook. Logged-out users must not
      load or view its private data, including previously cached Guildbook data.
      Logged-in users may query only the Guildbook observations collected by
      installations verified as their own; guild membership or a known guild ID
      alone must not grant access to other accounts' collected snapshots.
- [ ] Enforce account ownership server-side for protected reads and writes
      through database policies and RPC/API authorization. Derive the caller
      from the validated session; never trust a client-supplied account,
      installation, character or guild ID as authorization. UI hiding alone
      is insufficient.
- [ ] Create a feature/access matrix for Guildbook and later account-bound
      features, such as synced quest history, personal statistics and saved
      preferences. Default protected queries to the current account's collected
      data; login must not grant unrestricted access to the full database.
      Decide any intentionally shared catalog/aggregate access separately and
      explicitly before rollout.
- [ ] Scope local private caches by account, clear private views on logout,
      expiry and account switch, and cancel/discard in-flight responses from the
      previous session so they cannot repopulate another account's UI.
- [ ] Define logged-out/offline behavior for local collection and queued sync,
      and ensure queued data cannot be uploaded under the wrong account.
- [ ] Add acceptance checks for two distinct accounts, logged-out and anonymous
      callers, forged ownership IDs, direct API calls, session expiry/restart,
      logout/account switching and migration of existing installations. Prove
      each account can access its own data and cannot read or modify the other's.

Delivery order: agree the identity/ownership and feature-access contracts ->
session/login flow and existing-data migration -> backend enforcement +
Guildbook gating -> extend the same account boundary to later private features.
Keep the current live baseline and this planned access model distinct; this
roadmap entry does not deploy login or change production permissions.

## Future — Guildbook

Research note: [Guildbook API options](GUILDBOOK-API.md)

- [x] Runtime capability probe for Forever guild roster/profession APIs (`/fdb guildapi`) — function availability + own-character professions PASS.
- [x] Guilded-character roster/member profession acceptance — PASS (expanded member rows returned).
- [x] Targeted guild recipe-query acceptance completed — current Forever build is RUNTIME LIMITED for guild recipe/crafter lookup; defer to a later compatibility pass.
- [x] Guild roster SavedVariables contract — schema 9.
- [x] Character + profession model and private per-installation Supabase storage.
- [x] Companion Guildbook tab with guild selector, filter, roster/status/profession columns.
- [ ] Optional Battle.net enrichment if Forever realm/profile support is verified.

## Web — public ForeverDB website (foundation)

PR #22 merged to `main` (2026-10-10). **Website status: repo-complete foundation MVP on synthetic sample data; separate public infrastructure not provisioned and web publication/export (`0010`) not deployed.** Docs: [docs/web/](web/README.md).

- [x] Repository audit, production ledger (read-only) and threat model. Finding F-3: the Companion stats RPCs previously under-counted the observed-rate denominator for multi-installation buckets. **F3_FULLY_VERIFIED (2026-10-10): production SQL PASS and Windows Companion acceptance 5/5 PASS** (see below).
- [x] Isolated public read model (`database/public-read/`) with least-privilege `web_reader`/`publisher` roles, RLS-guarded staging, versioned atomic activation and rollback.
- [x] Allowlisted production export `0010_public_projection_export.sql`. **Prepared, NOT applied; needs owner approval.**
- [x] Fail-closed publication worker (`publisher/`): strict contract, name sanitization, sample thresholds, Wilson intervals, dominance flag, deterministic hash.
- [x] Next.js 16 website: search, item/creature/object/fishing/zone pages, news/guides/blog (Markdown), RSS, sitemap, nonce CSP, distributed rate limiting, progressive Turnstile challenge.
- [x] Local evidence: web unit 115/115, publisher 29/29, SQL security + zone-semantics suites, pipeline E2E, fixture↔PostgreSQL parity 37/37, Playwright 46/46 (incl. axe WCAG 2.2 AA) on fixture and 18/18 on Postgres adapter.
- [x] PR #22 hardening (implemented, locally tested): dedicated fail-closed rate limit + bounded body for `POST /api/v1/challenge`; zone item statistics no longer present global drop counts as zone-specific (item↔zone is *inferred*, count *not measured*).
- [x] GitHub CI on PR #22 hardening commit `3e463f3` and documentation head `66ae5c3` verified green; merged as `b972431d`.
- [x] **Vercel preview hardening (PR `web/vercel-preview-hardening`, 2026-10-10):** explicit, fail-closed `FOREVERDB_DEPLOYMENT` designation (hosted deployments never fall back to `local`; Vercel's production target is not ForeverDB production), noindex on every non-production response, `X-ForeverDB-Deployment` header, `Secure`/`__Host-` session cookie keyed to the real https origin, private-backend credentials rejected, CI split into `Web code quality` / `Web E2E (Playwright)` / `publisher-and-pipeline` / `codeql` plus the aggregate `Web release gate`, Node.js pinned to 24.x (`.node-version`, `engines`, CI check), reusable `web/scripts/verify-deployment.mjs`. Docs: [vercel-environments](web/vercel-environments.md), [release-gates](web/release-gates.md). **Status: PREVIEW HARDENED (code and CI) / PRODUCTION STILL BLOCKED.**
- [x] **PR #45 merged (2026-10-11):** `6b49a3f`; post-merge CI 7/7 PASS; Vercel deployment READY under Node 24 and All Deployments Authentication; configured as synthetic Preview mode. Existing GitHub ruleset #24853899 protects `main` with six GitHub Actions-origin checks.
- [ ] **Release promotion gate:** `release` created from `6b49a3f`; owner must include `release` in the existing active GitHub ruleset and set Vercel Environments → Production → Branch Tracking to `release`, then verify. This is the prerequisite for merging incomplete Account System V1 work into `main`.
- [ ] **Separate optional security acceptance:** automated external protection test and controlled failing-check PR to demonstrate enforcement. Manual incognito checks of production alias, API meta and branch preview PASS.
- [ ] Provision public DB, Upstash, WAF ([infrastructure setup](web/infrastructure-setup.md)). The Vercel project already exists.
- [ ] Production 0010 approval + first real publication.
- [ ] Staging load test; manual accessibility pass; editorial review of sample articles.
- [ ] Phase D: map layer with licensed/original backgrounds, comparisons, account features (separate security gate).

### Milestone — ForeverDB Account System V1 (specification in review; production BLOCKED)

Unified identity for the website and the Windows Companion with independent sessions, verified installation ownership and account-scoped Guildbook access. Specification and ledger: [docs/account-v1/](account-v1/README.md). Five independently reviewable PRs, none merged automatically:

- [x] **PR A — specification and security foundation** (`account/v1-spec-foundation`): audit of `main`, ADR-015..018, threat model, claim protocol and migration `0012` plan, Auth-only configuration validator (`production` hard-blocked), closed endpoint/RPC/redirect contracts, static boundary tests. **IMPLEMENTED; CI VERIFIED when the PR checks pass; independent review recorded in the PR.**
- [ ] **PR B — Web Auth:** registration, verification, login/logout, recovery, sessions, profile; real-GoTrue CI job. BLOCKED on PR A.
- [ ] **PR C — Ownership and Guildbook backend:** forward-only `0012`, claim/consume, account RPCs, SQL negative matrix. BLOCKED on PR A.
- [x] **PR D — Companion registered accounts** (`account/v1-companion-auth`, [companion.md](account-v1/companion.md)): fixed the anonymous identity-loss defect, six session states, DPAPI slots with atomic writes and a machine-wide lock, registered sign-in/sign-out, ownership-aware per-installation sync, claim initiation, closed feature gate (production OFF), Windows regression suite and workflow, Companion `0.9.0-alpha`. **IMPLEMENTED; CI VERIFIED when `Companion account auth (Windows)` passes on the final head; real-Windows UI acceptance PENDING; redemption on the website and end-to-end acceptance remain PR E.**
- [x] **PR E — Website linking, private Guildbook and integrated acceptance** (`account/v1-end-to-end-integration`, [report](account-v1/integration-and-acceptance-report.md)): `/account/link` with fresh-password + same-UID reauthentication, closed PostgREST client, installation list, private Guildbook, integrated real GoTrue + real PostgREST + SQL suite (`Account end-to-end (GoTrue + PostgREST)`), staging runbook and Windows checklist. **IMPLEMENTED; CI VERIFIED when the checks pass. STAGING VERIFIED / WINDOWS VERIFIED: pending (owner). Password reset now revokes every session of the account (owner decision, verified in CI).**
- [ ] **Production activation: BLOCKED** (owner approval, dry-run, rollback; code constant `PRODUCTION_ACCOUNT_AUTH_APPROVED` is false). Migration `0010` stays unapplied; registered quota tiers are a separate later milestone.

### F-3 — Companion observed drop-rate denominator (F3_FULLY_VERIFIED — 2026-10-10)

PR #37 merged to `main` as `6d0df83`; migration `0011` applied to production `wow-forever` (`klxhikdlfwgxurdyexdi`) on 2026-10-10 15:15:18 UTC, **ledger `20261010151518 fix_observed_drop_rate_denominator`**. **Status: F3_FULLY_VERIFIED. Production SQL and real Windows Companion 0.8.2-alpha item/source UI checks both PASS (5/5, 2026-10-10).** Record, evidence, hashes, rollback: [docs/f3-observed-rate-denominator.md](f3-observed-rate-denominator.md).

- [x] Root cause proven, forward-only migration and verified rollback merged (PR #37); regression suite in CI.
- [x] Read-only preflight, then `apply_migration` of `0011` only (`0010` not applied); function bodies byte-identical to the reviewed file.
- [x] Production SQL verification: ledger, hashes, owner/ACL/`SECURITY DEFINER`/`search_path` unchanged, anon denied, wrappers and 0009 gate unchanged, corrected denominators on all 374 buckets, 21 affected (max correction 25.00 points, average 5.88), 353 unchanged, performance in line with baseline.
- [x] **Manual Windows Companion acceptance (PASS — 2026-10-10, 5/5 checks):** Shadowgem at Copper Vein (mining) 1/110 = 0.9 % in both item and source details; Fractured Canine at Cursed Darkhound level 8 1/12 = 8.3 %; Putrid Claw at Rotting Dead level 6 2/5 = 40.0 %; unchanged Raw Brilliant Smallfish at Tirisfal Glades 10/28 = 35.7 %. User-supplied 0.8.2-alpha screenshots; see the F-3 acceptance record. Manual Sync/Guildbook remain independent gates.

## 0.9 — Farming intelligence

- [ ] “Where should I farm this?” view.
- [ ] Combine observed rate, sample quality and location density.
- [ ] Per-zone source comparison.
- [ ] Route-friendly node density summaries.
- [ ] Source/location filters by acquisition type.
- [ ] Data-quality/confidence visualization.

## 1.0 readiness

- [ ] Stable addon data contract.
- [ ] Stable Companion local cache format or migration path.
- [ ] Full supported collector E2E matrix.
- [ ] Security/advisor review with no critical findings.
- [ ] Signed installer/update story.
- [ ] Recovery behavior for malformed SavedVariables, auth failures and stale builds.
- [ ] User-facing privacy/data collection documentation.

## Engineering rules

1. The addon never performs HTTP.
2. Blizzard/WoW artwork is resolved from the user's exact WoW build. Local CASC is
   preferred; streamed files may be fetched from Blizzard's CDN and cached locally.
   ForeverDB does not redistribute map textures through Supabase.
3. Supabase stores observations/statistics/metadata, not copyrighted client art.
4. New map/resolver behavior must keep structured diagnostics until the pipeline is
   considered stable.
5. Failed expensive work should be cached or deduplicated so normal UI navigation
   never repeatedly scans CASC.
6. Every collector type must pass an end-to-end addon -> SavedVariables ->
   Companion -> Supabase -> search/details verification before being called done.
