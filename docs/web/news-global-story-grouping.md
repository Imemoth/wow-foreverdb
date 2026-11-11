# News global story grouping (EU/US) — architecture, evidence and rollout

Status (2026-11-11): **migration `0013` and the four reviewed overrides are applied in production (since 2026-11-05); no story link exists yet (`pub.news_story_members` has 0 rows), so nothing changes for readers; the website code in this PR is not deployed.** The link write `news_link_stories(true)` needs the owner's separate explicit approval (current-data dry-run and risks: section 11). Independent of G5, migration 0012 and the dependency-audit decision.

## 1. Problem

Blizzard posts one forum topic per region (and sometimes cross-posts the same announcement into several forum categories of one region). The topics have different ids, so AzerDex showed the same announcement more than once. Goal: **one visible story** with both original regional sources preserved, in the cards, filters, search, detail pages, homepage, RSS and sitemap.

## 2. Architecture decision

* **Presentation grouping in the shared read model, not in React and not in ingestion.** `news_apply_sync`, the collector and every `news_entries` / `news_post_versions` / `news_tracked_topics` row are untouched. No story copies source entries.
* **Persisted, reviewable links** instead of matching in the read path (no fuzzy logic on production reads):
  * `pub.news_story_members (thread_key PK, story_key, basis, evidence, linked_at)` — a thread belongs to at most one story. `story_key = 'story:' || <earliest member thread>`, so the story key is **stable** (new members adopt the existing key) and its suffix identifies the **canonical thread**.
  * `pub.news_story_overrides` — reviewed human decisions: `allow` (merge although the automatic rule does not hold) / `deny` (never merge). Reasons and the decider are mandatory.
  * `pub_admin.news_link_stories(p_apply boolean default false)` — the **only writer**: deterministic, explainable, dry-run by default (returns the exact plan: stories, review pairs, ambiguous groups), no input from the web; `EXECUTE` only for the owner role and the platform admin (not the web reader, publisher or ingest role).
  * `web_api.news_stories(...)` / `web_api.news_story_entry(slug)` — read functions (granted to `foreverdb_web_reader` only). The existing `news_cards`, `news_list`, `news_featured`, `news_entry` keep their signatures and behaviour.
* **Why not a view over a rule?** A computed view would re-run an unreviewed matcher on every read, could flip a story when a later post arrives, and leaves no place for human overrides. Persisted links are auditable, overridable and cheap.
* **Backward compatible rollout:** with no rows in `news_story_members` every thread is its own story and `news_stories` returns the cards of `news_cards` (asserted by a test). The website tries `news_stories` and falls back to `news_cards` on "undefined function" (`42883`, silently), so **the website may deploy before or after the migration**.

## 3. Matching strategy (`exact_content_v1`) — conservative and explainable

Two verified Blue Post thread **openers** are the same announcement only if **all** hold:

1. identical normalized **title** (case, punctuation, curly quotes/dashes, HTML entities ignored; non-empty);
2. identical normalized **author** (non-empty);
3. openers published **≤ 15 minutes** apart;
4. identical normalized **excerpt of ≥ 40 characters** — an empty or short excerpt is never evidence.

A group of threads joined by passing pairs must be a **clique** (every pair passes) and may touch at most one existing story; otherwise it is reported as *ambiguous* and everything stays separate. Equal-title, near-in-time pairs that fail another criterion are listed as *review*. Official News articles (no thread), unverified, suppressed or future-dated rows are never matched. Evidence considered and **not** used for automatic merging: fuzzy similarity (kept as `review`), publication-time proximity alone, title alone.

**Same-title topics inside one region** (verified 2026-11-04 by fetching the live topics): they are Blizzard **cross-posts into different forum categories** (different `category_id`, e.g. US 2390465 in category 349 and 2390466 in 347; EU 637227 in 362 and 637228 in 360) with identical text and links to the same Blizzard news article. They are the same announcement, so they join the same story; **recurring titles** (e.g. a weekly reminder) are days apart and never merge (tested).

## 4. Production inventory (refreshed read-only, 2026-11-04)

55 Blue Post threads (29 US, 26 EU); **16 candidate title groups** covering 36 threads (4 same-title-same-region repeats). The exact matcher was run **read-only against production** (same logic as the function, as a SELECT; nothing was created there):

**13 confirmed stories, 30 threads** (all: same author, openers 0–4.7 min apart, identical normalized excerpt):

| Story (canonical thread) | Threads |
|---|---|
| Datamined in the Latest Beta Build | US 2385060 + EU 636148 |
| Explore the New Dungeons of World of Warcraft: Forever | US 2387658 + EU 636727 |
| World of Warcraft: Forever Raid Overview—Locations, Raid Bosses… | US 2387820, 2387821 + EU 636735 |
| Gather Around the Campfire in World of Warcraft: Forever | US 2388645 + EU 636870 |
| The Roleplay-PvP Ruleset is Coming to WoW Forever | US 2389502 + EU 637031 |
| Thank You For Testing the WoW Forever Beta | US 2390465, 2390466 + EU 637227, 637228 |
| Dive Into WoW: Forever, the Gods of Zul’Aman, Hallow’s End… | US 2390480, 2390481 + EU 637232 |
| Watch the WoW: Forever Short Story, “Unbowed” | US 2392363 + EU 637597 |
| Your Next Adventure in WoW: Forever Starts in the WoW Podcast | US 2393349 + EU 637932 |
| New Player’s Starter Guide: Welcome to World of Warcraft | US 2394974 + EU 638305 |
| Return to Azeroth in World of Warcraft: Forever | US 2395922 + EU 638484 |
| WoW: Forever—What’s New and What Feels Familiar | US 2400000 + EU 639257 |
| Explore WoW: Forever with a Gamepad | US 2400119 + EU 639280 |

**Owner decisions of 2026-11-04 (4 pairs, evidence in `docs/web/evidence/news-story-decisions-2026-11-04.json`, code mirror `web/src/lib/news/reviewed-story-decisions.ts`).** These are decisions, **not** a production write: the override rows, the link write and the deployment each need their own approval.

| Decision | EU thread | US thread | Basis |
|---|---|---|---|
| **ALLOW** WoW Forever Beta Development Notes | `eu:topic:631316` (post:6391795) | `us:topic:2360696` (post:30185131) | same author, byte-identical 420-char opener, 14.2 min apart; titles differ only by date wording ("Updated 3 November" / "Updated November 2"). The US opener was ingested by the normal collector on 2026-11-04 19:40 UTC. |
| **ALLOW** Podcast Episode 5 - End of Beta Special | `eu:topic:637043` (post:6446965) | `us:topic:2389565` (post:30577452) | identical title and author, 47 s apart, empty excerpts; equivalence verified against the live sources |
| **ALLOW** Podcast Episode 6 - All About Tech | `eu:topic:638462` (post:6462927) | `us:topic:2395799` (post:30671248) | identical title and author, 28 s apart, empty excerpts; equivalence verified against the live sources |
| **DENY** Beta Celebration is Underway | `eu:topic:637055` (post:6447060) | `us:topic:2389633` (post:30578134) | region-specific event times; excerpts differ (similarity 0.885); both regional cards are preserved |

`database/public-read/ops/news_v2_story_overrides_review.sql` (its four rows are present in production, see section 11) inserts exactly these four rows, fail-closed on the reviewed post ids / authors / excerpt relations and on an existing override, and never writes a link; `ops/news_v2_story_overrides_rollback.sql` deletes only those rows. Gate order: **0013 approved → story overrides approved → `news_link_stories(true)` approved → website deployment approved.**

**Production inventory recomputed 2026-11-05 (read-only matcher run on the live openers, 59 = US 31 + EU 28):** automatic rule only → 16 stories (36 threads), 3 review pairs (Podcast 5, Podcast 6, Beta Celebration), 0 ambiguous, **39 Blue Post cards**. With the four owner decisions → **19 stories (42 threads), 0 ambiguous, 36 Blue Post cards**; Beta Celebration stays two regional cards. (The earlier snapshot had 55 openers / 13 stories; the normal collector has ingested four more openers since, including the US Development Notes thread.) The inventory is recomputed once more immediately before the rollout proposal.

**Before/after (Blue Post cards):** 55 → **38** (US view 29 → 26, EU view 26 → 25); the 49 Official News cards are unaffected, so the all-categories total drops by 17.

## 5. UX

* `/news` (All regions): one card per story with `Regions: EU · US`; a single-region Blizzard post is labelled `US only` / `EU only`. The card links to the story's newest verified official post.
* **US / EU filters**: a story appears in a region iff it has a verified source there, with **that region's own content and updates** (filter → group → count → page, so totals and pagination are exact; search covers verified content of either source in All regions, and only the region's own in a region view).
* **Detail** (any old URL): header `Regions: EU · US`; section *Official sources (EU · US)* with one block per region (title, first posted, latest official update, author, "Open the EU/US official source ↗") and, per region, its verified official update history. Single-region posts keep the previous layout. Screenshots: `docs/web/news-story-grouping/` (`news-all-regions.png`, `news-eu-filter.png`, `story-detail.png`).

## 6. RSS, SEO and URLs

| Topic | Decision | Evidence |
|---|---|---|
| RSS items | one per story, dated by the latest verified official activity; `<category>` lists both regions | unit + E2E |
| GUID | permalink of the story's **newest verified official post**. Merging two existing threads reuses one of their existing GUIDs ⇒ **no repeat notification**; a genuinely new official post in either region has a new permalink ⇒ a new item (as before) | `news-stories.test.ts` (guidsBefore ⊇ guidsAfter) |
| Existing URLs | every `/news/entry/<slug>` stays valid (200, no redirect, no deletion) and shows the whole story | SQL + E2E (3 slugs) |
| Canonical | `<link rel=canonical>` of every member URL = the **canonical thread's opener** (story_key suffix) — one indexed URL, regional pages remain reachable without duplicate-content risk | E2E |
| Sitemap | the canonical URL once per story (never the regional duplicate) | unit |
| Structured data | `NewsArticle` per story: `datePublished` = first posted, `dateModified` = latest verified update, `mainEntityOfPage` = canonical URL, `isBasedOn` = every regional Blizzard source | E2E |
| Source material | nothing marked deleted; all regional links, thread ids, post ids, hashes, provenance, versions and timestamps preserved | SQL fingerprint test |

## 7. Security audit of the migration

Tables: RLS on, **no policies, all privileges revoked** from `PUBLIC, anon, authenticated, foreverdb_web_reader, foreverdb_publisher, azerdex_news_ingest`. Functions: `SECURITY DEFINER`, `search_path = ''`, revoked from `PUBLIC`; `news_stories` / `news_story_entry` → `foreverdb_web_reader` only; `news_link_stories` → owner (+ platform `postgres` for operations), **not** web reader / publisher / ingest. Inputs of the read functions keep the V2 bounds (limit ≤ 50, offset ≤ 5000, query ≤ 80 chars without wildcards, category/region allow-lists). The migration ends with a self-check of every grant, definition and RLS flag. `news_apply_sync` and the collector are unchanged.

## 8. Migration, rollout and rollback

* **Number:** `0013`, **applied in production on 2026-11-05 05:25 UTC** as ledger entry `20261105052509 news_global_story_grouping` (`0012` is `news_revision_due_tolerance`, long merged). The applied text is this file without comments (see section 11).
* **Rollout order (each a separate owner approval):**
  1. ~~apply migration `0013`~~ **done 2026-11-05** (additive, idempotent, no data, no behaviour change: no links ⇒ identical cards);
  2. dry-run `select pub_admin.news_link_stories(false)` — current-data result in section 11 (the 2026-11-04 expectation of 13 stories / 30 threads / 3 review pairs is superseded); then the **data write** `news_link_stories(true)` (inserts the planned link rows only, 45 on 2026-11-11; fingerprint of every source table unchanged; idempotent);
  3. deploy the website (safe before or after step 1 thanks to the fallback);
  4. optional, later: a cron job that runs `news_link_stories(true)` a few minutes after the collector so new announcements are grouped automatically (until then a new cross-region announcement shows as two cards until the next link run).
* **Rollback:** `ops/news_v2_0013_rollback.sql` — drops only the story functions/tables (refuses while overrides exist; fingerprint check of source tables; V2 readers verified afterwards). Website: promote the previous deployment (no DB dependency; fallback keeps working either way). Tested on PostgreSQL 16 and 17.

## 9. Known risks

* **False negatives (separate cards that are one story):** empty-excerpt or differently worded posts (3 review pairs today), titles that differ by date wording (Dev Notes). Mitigation: review list + reviewed `allow` overrides.
* **False positives:** two *different* announcements by the same author with identical title **and** identical ≥ 40-char excerpt within 15 minutes. Conservative by construction (all four conditions, clique); a reviewed `deny` override prevents a merge; every link keeps `basis`/`evidence` for audit and can be deleted without touching source data.
* **Timing:** an announcement is linked only after both regional threads exist and a link run happens; until then two cards (no data loss).
* **Canonical stability:** the canonical thread is fixed at story creation; a later-ingested *earlier* thread joins the story without changing it.
* The story card follows the newest verified official post, so its permalink (and RSS GUID) changes with each new update — intentional (new item), identical to thread behaviour before.

## 10. Tests

SQL `tests/news_v2_story_grouping.sql` (fixtures for every acceptance case; PostgreSQL 16 + 17) · unit `news-stories.test.ts` (rule, cards, filters, totals/pagination, search, URLs, immutability, RSS GUID stability, sitemap, **production-shaped inventory: 13 stories / 30 threads / 3 review / 55 → 38**) · Playwright `news-stories.spec.ts` (global/US/EU cards, labels, near-miss separation, search, detail sources, canonical, JSON-LD, old URLs, RSS) · existing News V2 SQL/unit/E2E suites unchanged and green.

## 11. Production state and current-data dry-run (read-only, 2026-11-11)

Evidence only; nothing was written. All queries were read-only on the production project.

**State.** Migration `0013` is applied (ledger `20261105052509 news_global_story_grouping`, 19,339 bytes). The file in this PR is 22,657 bytes; with `--` comments removed and whitespace collapsed both texts are identical (14,792 characters, md5 `94f7303661bae4ce699f1a3e7ea7d3b5`), so the difference is comments only and the file stays the source of truth. `pub_admin.news_link_stories`, `web_api.news_stories` and `web_api.news_story_entry` exist. `pub.news_story_overrides` holds the 4 reviewed rows (3 ALLOW, 1 DENY); `pub.news_story_members` holds **0** rows (confirmed again after the dry-run).

**Website fallback.** `postgres-adapter.ts` maps SQLSTATE `42883` (undefined function) to a fallback to `news_cards`, and the SQL suite asserts that with no links `news_stories` equals `news_cards`; production is exactly in that state (functions present, 0 links), so this PR changes nothing visible until the link write. Verified by code and by the CI suites (SQL on PostgreSQL 16 and 17, unit, Playwright); the production read functions are not callable by the SQL tool role (by design), so no production read of them was made.

**Dry-run `select pub_admin.news_link_stories(false)`** (`applied: false`, rule `exact_content_v1`): 73 eligible threads (55 on 2026-11-04), **20 stories covering 45 threads to link**, 4 review pairs, **0 ambiguous**. Cards would go 73 to 48. The 13 stories confirmed on 2026-11-04 are all present except the Roleplay-PvP pair (below); new since then: the Dev Notes pair (ALLOW override), Podcast Episode 5 and 6 (ALLOW overrides), "Now Live!", "Pouch of Violet Dust", "Issues Resolved for Invite-a-Friend Players", "Watch Forging Forever" (EU + two US cross-posts) and "Prepare for Forever..." (two US cross-posts only).

| Review pair (stays separate) | Reason |
| --- | --- |
| Roleplay-PvP Ruleset, `eu:topic:637031` / `us:topic:2389502` | `content_differs_or_excerpt_too_short`. **Changed since 2026-11-04** (then a confirmed story): the EU opener's stored excerpt is now 307 characters ending in a literal `&hellip;` entity, the US one 420 characters ending in `…`. An excerpt-extraction difference in the stored data, not a matching defect; the safe outcome is two cards. |
| Beta Celebration, `eu:topic:637055` / `us:topic:2389633` | `denied_by_override` (reviewed DENY) and content differs. Expected. |
| Prepare for Forever..., `eu:topic:641161` / `us:topic:2408668` and `us:topic:2408677` | content differs; the two US cross-posts are linked, the EU thread stays a separate card. |

**Risks before any write.** (1) The data moved since the reviewed inventory (73 vs 55 threads), so the 2026-11-04 owner review does not cover the 5 stories matched automatically since then ("Now Live!", "Pouch of Violet Dust", "Issues Resolved for Invite-a-Friend Players", "Watch Forging Forever", "Prepare for Forever..."); the Dev Notes and the two Podcast stories come from your reviewed overrides. Per-story evidence: `docs/web/evidence/news-story-links-review-2026-11-11.md`. (2) The Roleplay-PvP pair would stay split; a reviewed ALLOW override (or re-ingesting that EU thread) would merge it; not proposed here. (3) The EU excerpt entity (`&hellip;`) suggests collector excerpt normalisation is not identical across regions; worth a separate look, not a blocker. (4) The write is idempotent (`on conflict (thread_key) do nothing`) and reversible by deleting the link rows (source tables are untouched); the rollback script refuses while overrides exist.

**Approval boundary.** `news_link_stories(true)` is not authorised by this document or this PR.
