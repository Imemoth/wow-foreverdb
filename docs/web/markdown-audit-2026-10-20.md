# Repository Markdown audit — 2026-10-20

Status: **AUDIT, not a rewrite.** Produced as part of AzerDex P2-E (Addon & Companion Experience). Scope: inventory and classify every tracked `.md` file, verify a short list of specific candidate discrepancies named in the P2-E task, and make the one unambiguous, low-risk correction found. Historical acceptance/evidence records are preserved verbatim; staleness found in them is recorded **here**, not edited into the original file.

Total tracked Markdown files (`git ls-files '*.md' | wc -l`): **85**.

## Inventory by directory

### Root (2)
| File | Classification |
| --- | --- |
| `README.md` | Current and consistent *(one discrepancy fixed — see below)* |
| `CHANGELOG.md` | Current and consistent |

### `docs/` top level (12)
| File | Classification |
| --- | --- |
| `docs/ROADMAP.md` | Current but outdated/incomplete — Addon/Companion/Account roadmap is current; has **no AzerDex website milestone ledger** (see discrepancy #2) |
| `docs/VERSIONING.md` | Current and consistent — authoritative version source-of-truth table, matches code |
| `docs/DATA_MODEL.md`, `docs/SYNC.md`, `docs/GUILDBOOK-API.md` | Current and consistent (not re-verified line-by-line; no P2-E-relevant claims) |
| `docs/BETA_TEST_PLAN.md` | Historical snapshot — preserve |
| `docs/0.5-acceptance-test.md`, `docs/0.5-session-tracker-acceptance.md`, `docs/0.6-map-test.md`, `docs/0.7-acceptance-test.md`, `docs/0.7-auto-atlas-verification.md`, `docs/0.7-full-map-art-investigation.md`, `docs/0.7-zone-only-database-browse.md`, `docs/0.8-api-security-hardening.md`, `docs/0.8-guildbook-acceptance.md`, `docs/0.8-sync-health-acceptance.md` | Historical snapshot — preserve (dated acceptance records for shipped Addon/Companion milestones) |
| `docs/f3-observed-rate-denominator.md` | Historical snapshot — preserve (F3_FULLY_VERIFIED, production-applied, dated) |
| `docs/legacy-stats-prod-cutover.md` | Historical snapshot — preserve |
| `docs/third-party-map-atlas-notice.md`, `docs/client-map-assets.md` | Open specification / P2-D-adjacent licensing records — **out of scope for P2-E**, not inspected further |

### `docs/web/` (13) — all individually reviewed
| File | Classification |
| --- | --- |
| `docs/web/README.md` | Current and consistent (index; orchestrator is updating it to list the new roadmap/audit docs as part of the parent P2-E task) |
| `docs/web/api-contract.md` | Current and consistent |
| `docs/web/architecture-decisions.md` | Current and consistent (ADR-015 Account/Auth boundary referenced elsewhere; not itself stale) |
| `docs/web/data-classification.md` | Current and consistent |
| `docs/web/threat-model.md` | Current and consistent |
| `docs/web/publication-pipeline.md` | Current and consistent |
| `docs/web/verification-results.md` | Historical snapshot — preserve (dated CI/test run record) |
| `docs/web/00-current-state-assessment.md` | Historical snapshot — preserve (dated baseline; not edited) |
| `docs/web/arcane-cartography-phase2a.md` | Historical snapshot — preserve (P2-A architecture record, superseded in presentation by the later P2-A visual-polish round but still an accurate record of what it documents) |
| `docs/web/maps-and-assets.md` | Open specification / P2-D-adjacent — out of scope for P2-E |
| `docs/web/release-gates.md` | Current but outdated/incomplete — accurate on CI job structure; `release` branch protection and the failing-check verification are still open checkboxes (correctly marked `[ ]`, not a discrepancy) |
| `docs/web/go-live-checklist.md` | Current and consistent — explicitly about **future real-data Production**, correctly keeps every A–D gate open; does not claim the synthetic public beta satisfies any of them |
| `docs/web/vercel-environments.md` | Current but outdated/incomplete — **discrepancy #3, see below** |
| `docs/web/infrastructure-setup.md` | Current but outdated/incomplete — **discrepancy #4, see below** |

### `docs/account-v1/` (24)
All scoped to the original Account V1 PR A–E ledger (registration/login/sessions/linking/Guildbook). `docs/account-v1/README.md`'s own target-outcome line — *"UNIFIED ACCOUNT SYSTEM V1 IMPLEMENTED AND VERIFIED IN ISOLATED DEVELOPMENT/STAGING, WITH PRODUCTION ACTIVATION EXPLICITLY BLOCKED UNTIL OWNER APPROVAL"* — is accurate and consistent with every file in the set; none of them claims production activation. Classification: **Current and consistent** for `README.md`, `architecture.md`, `security.md`, `companion.md`, `companion-device.md`, `web-auth.md`, `web-devices.md`, `web-linking.md`, `ownership-claim-protocol.md`, `pr-obligations.md`, `integration-and-release-order.md`. **Historical snapshot — preserve** for the dated acceptance/evidence records: `0012-deployment-and-recovery.md`, `acceptance-and-owner-actions.md`, `acceptance-zero-touch.md`, `activation-download-origin-fix.md`, `adr-017-zero-touch-enrollment.md`, `integration-and-acceptance-report.md`, `private-claim-pilot.md`, `private-project-companion-pilot.md`, `release-integration-2026-10-16.md`, `single-project-candidate.md`, `staging-runbook.md`, `windows-acceptance-checklist.md`, `zero-touch-enrollment-registered-sync.md`, `zero-touch-pilot-closure.md`, `zero-touch-rpc-contract.md`.

Note: **none of the 24 files mention "Browser Pairing," "Stage B," "Stage C," or PR #62** — confirmed by repo-wide grep. Browser Pairing V1 (PR #62) exists only on its own unmerged `feature/browser-pairing-v1` branch targeting `main`; no file reachable from `web/azerdex-beta` documents it. This is correct (it hasn't merged anywhere), but means the Download page must not cite a docs/account-v1 path for pairing status — see quotes section below.

### `docs/azerdex-*-art/` provenance (4)
`docs/azerdex-card-art/provenance.md`, `docs/azerdex-database-zones-art/provenance.md`, `docs/azerdex-hero-art/provenance.md`, `docs/azerdex-library-art/provenance.md` — all **Current and consistent**, completed asset-provenance records from earlier verified rounds. Not touched. (`docs/azerdex-news-blog-art/provenance.md` likewise.)

### `docs/superpowers/` (4)
`plans/2026-09-27-collector-acceptance.md`, `plans/2026-09-28-session-tracker.md`, `plans/2026-10-14-zero-touch-activation-origin-403.md`, `specs/2026-09-28-session-tracker-design.md` — **Historical snapshot — preserve** (dated planning artifacts).

### `web/content/**/*.md` (8)
`web/content/blog/building-a-safe-public-database.md`, `web/content/guides/fishing-zones-and-pools.md`, `web/content/guides/getting-started-with-foreverdb.md`, `web/content/guides/mining-copper-in-tirisfal.md`, `web/content/guides/reading-observed-drop-rates.md`, `web/content/news/companion-guildbook-polish.md`, `web/content/news/introducing-foreverdb-web.md`, `web/content/news/zone-browsing-and-api-hardening.md` — **Editorial sample**, all 8 correctly carry `sample: true` frontmatter (verified). `getting-started-with-foreverdb.md` was specifically checked for installer overclaims (discrepancy candidate #8): it describes manual copy-to-`AddOns` installation and generic Companion sync only, never a signed installer or one-click download. No correction needed.

### Component/test README-style docs (5)
`companion/README.md`, `database/tests/account/README.md`, `web/README.md`, `web/src/components/hero/README.md`, `web/tests/auth-stack/README.md`, `web/tests/e2e-stack/README.md` — **Current and consistent** (not re-verified line-by-line; local developer-facing docs, no release-status claims).

## Confirmed discrepancies

### 1. Root `README.md` addon version — HIGH — FIXED NOW
- **Location:** `README.md`, "Current versions" table.
- **Evidence:** `README.md` stated Addon **0.4.1-alpha**. `docs/VERSIONING.md` names `addon/ForeverDB/Core.lua` + `addon/ForeverDB/ForeverDB.toc` as the explicit source of truth; both read `FDB.VERSION = "0.5.0-alpha"` / `## Version: 0.5.0-alpha`. `docs/VERSIONING.md`'s own matrix already said **0.5.0-alpha**.
- **Correction:** Changed `README.md`'s table entry to **0.5.0-alpha**. One-line fix, no other content touched.
- **Status:** Fixed now.

### 2. `docs/ROADMAP.md` has no AzerDex website milestone ledger — HIGH — Needs owner decision (action owned by the P2-E orchestrator, not this audit)
- **Location:** whole document (542 lines).
- **Evidence:** repo-wide grep for `azerdex`, `P2-A`..`P2-E`, `web/azerdex-beta` inside this file returns zero matches. The file's own `## Web — public ForeverDB website (foundation)` section (line 470) documents the **pre-rebrand** "ForeverDB website" MVP (PR #22, 2026-10-10) and stops there — it predates the AzerDex brand pivot and all of P1 and P2-A through P2-E.
- **Proposed correction:** add one short pointer from that section to the new authoritative `docs/web/azerdex-roadmap.md` (the P2-E task's own required deliverable). This audit does not create that file or edit `ROADMAP.md` — both are explicitly reserved for the parent P2-E work so the roadmap's content matches what's actually shipped on the Download page.
- **Status:** Flagged only (action deferred to parent task).

### 3. `docs/web/vercel-environments.md` predates the narrow public-beta-homepage indexing exception — HIGH — Needs owner decision
- **Location:** §"environment matrix" table (line ~17-22), "Indexing" row.
- **Evidence:** the table states indexing is `noindex, nofollow` for both Local and "Protected preview" with no third state — it predates the later, narrowly-scoped exception that makes exactly `https://beta.azerdex.com/` (the homepage only) indexable while every other beta route stays noindex (implemented in `web/src/lib/seo.ts` / `env.ts`, verified live in the P2-A merge's public smoke test on 2026-10-20: homepage served `robots: index, follow`; `/database`, `/zones`, `/guides`, `/news`, `/blog`, `/account` all served `noindex, nofollow`). The document's fail-closed architecture description (deployment designation, cookie handling, header matrix) is otherwise still accurate and enforced.
- **Proposed correction:** add a dated addendum section documenting the narrow homepage exception and linking to `web/src/lib/seo.ts`'s `isPublicBetaHomepage` and the new `docs/web/azerdex-roadmap.md`. Not a rewrite of the existing table (which remains correct for every non-homepage route).
- **Status:** Flagged only — this document is not a one-line fix and is out of this audit's edit authorization; recommend the parent P2-E work or a follow-up docs PR add the addendum.

### 4. `docs/web/infrastructure-setup.md` header overstates "nothing provisioned" — MEDIUM — Needs owner decision
- **Location:** document title line 1 ("NOT done — requires owner approval") versus step 10 in its own table.
- **Evidence:** step 10 itself already states accurately: *"Vercel project (exists: `wow-foreverdb`, root directory `web/`, Hobby)... Current temporary demo and previews: `FOREVERDB_DEPLOYMENT=preview`, `FOREVERDB_DATA_SOURCE=fixture`"* — this is live today (confirmed against the deployed beta). Steps 1–9 and 11–13 (separate public DB, Upstash, WAF, custom domain beyond the existing `beta.azerdex.com`/`azerdex.com` Vercel-managed domains, monitoring) remain genuinely not provisioned. The top-of-file framing ("Nothing below has been provisioned") is only true if read as "nothing **beyond step 10**."
- **Proposed correction:** reword the title/intro to "Manual infrastructure setup — **mostly NOT done**; step 10's basic Vercel/Preview wiring is already live, see `vercel-environments.md`." A one-line clarifying edit, not a rewrite of the step table.
- **Status:** Flagged only (edit authorization not granted to this audit; low risk, recommend the parent task or a follow-up docs PR make it).

### 5–10 (candidates checked, **no discrepancy found**)
- `docs/web/go-live-checklist.md`: confirmed scoped to future real-data Production; no gate is marked done that shouldn't be; correctly separate from the already-live synthetic beta. **No correction needed.**
- `docs/web/00-current-state-assessment.md`: confirmed dated historical baseline; not edited. **No correction needed.**
- Account V1 docs: confirmed none claim Stage B/Browser Pairing is live or activated (none even mention it — see inventory note above). **No correction needed**, but see the quoted guidance below for what NOT to claim on the Download page.
- `web/content/guides/getting-started-with-foreverdb.md` and the other 7 editorial articles: confirmed no installer overclaim, `sample: true` present on all 8. **No correction needed.**
- `docs/azerdex-*-art/provenance.md` (4 files): confirmed accurate, completed records. **No correction needed.**
- `docs/web/maps-poc.md`, `docs/third-party-map-atlas-notice.md`, `docs/client-map-assets.md`: confirmed P2-D-adjacent and out of scope; not touched or further audited beyond confirming their existence and topic.

## Exact wording for the Download page / `docs/web/azerdex-roadmap.md`

- **Browser Pairing / PR #62 status** — use: *"Browser Pairing V1 (Stage B) is implemented and internally verified but not publicly activated; it remains blocked on an unresolved hosting-provider ingress guarantee, and Stage C (the Companion-side account connection flow) has not started."* Do **not** say "coming soon," "almost ready," or cite a specific date — PR #62 itself only gives an internal target of 2026-10-30 for Stage C, not a public release date, and no repo doc commits to one.
- **What the public beta currently contains** — use: *"synthetic sample data"* / *"invented test data produced by the publication pipeline, not real AzerDex observations"* (this is the site's own existing live banner copy — reuse it verbatim, don't paraphrase into something stronger or weaker).
- **Signed installer** — use: *"No signed, publicly distributed installer exists yet. Builds are currently produced by the project's own GitHub Actions workflows."* Never imply one is available or imminent.
- **Website roadmap gap** — use: *"`docs/ROADMAP.md` tracks Addon, Companion and Account System V1 milestones; it does not yet include the AzerDex website's own P1–P2 milestones — that ledger now lives in `docs/web/azerdex-roadmap.md`."*

`docs/web/markdown-audit-2026-10-20.md` (this file) is written at: `docs/web/markdown-audit-2026-10-20.md`.
