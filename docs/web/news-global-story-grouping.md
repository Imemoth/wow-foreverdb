# News global story grouping (EU/US) — architecture, evidence and rollout

Status: **Draft, not applied, not deployed.** Migration `0013` and the link run each need the owner's explicit approval. Independent of G5, migration 0012 and the dependency-audit decision.

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

**3 review pairs, stay separate** until a human confirms: *Podcast Episode 5* (US 2389565 / EU 637043) and *Podcast Episode 6* (US 2395799 / EU 638462) have an **empty excerpt** (no content evidence); *Beta Celebration* (US 2389633 / EU 637055) differs in wording (similarity 0.885). **0 ambiguous.** Not even a candidate (titles differ by date wording, so a false negative by design): the *WoW Forever Beta Development Notes* threads (US 2360696 "Updated November 2" vs EU 631316 "Updated 3 November"); the US thread is not yet ingested (G5 pending). A reviewed `allow` override would merge it (tested).

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

* **Number:** `0013` (the ledger ends at `news_collector_v2`; `0012` is taken by the open Draft PR #162; the number is re-checked before applying).
* **Rollout order (each a separate owner approval):**
  1. apply migration `0013` (additive, idempotent, no data, no behaviour change: no links ⇒ identical cards);
  2. dry-run `select pub_admin.news_link_stories(false)` — expect the 13 stories / 30 threads / 3 review pairs above; then the **data write** `news_link_stories(true)` (inserts 30 link rows only; fingerprint of every source table unchanged; idempotent);
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
