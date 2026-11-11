# News story links: current-data review evidence (2026-11-11)

Read-only. Source: `select pub_admin.news_link_stories(false)` on the production project at about 12:00 UTC (`applied: false`, rule `exact_content_v1`).
Nothing was written: `pub.news_story_members` still had 0 rows afterwards and `pub.news_story_overrides` still had the 4 reviewed rows.
**`news_link_stories(true)` is not authorised by this document.** Titles are cut at 70 characters. Thread ids are the public Blizzard forum topic ids.

## Totals

73 eligible threads (55 on 2026-11-04), **20 stories covering 45 threads to link**, 4 review pairs, 0 ambiguous groups. Blue Post cards would go from 73 to 48.

## The 20 stories, by provenance

Correction: an earlier note counted "7 new stories". The right split of the 20 is **12 + 3 + 5**.

**A. 12 stories already confirmed in the 2026-11-04 inventory (same author, identical normalised excerpt, openers within 15 minutes)**

| # | Story | Threads |
| - | --- | --- |
| 2 | Datamined in the Latest Beta Build | eu:636148 + us:2385060 |
| 3 | Explore the New Dungeons of World of Warcraft: Forever | eu:636727 + us:2387658 |
| 4 | World of Warcraft: Forever Raid Overview (Locations, Raid Sizes, ...) | eu:636735 + us:2387820 + us:2387821 |
| 5 | Gather Around the Campfire in World of Warcraft: Forever | eu:636870 + us:2388645 |
| 7 | Thank You For Testing the WoW Forever Beta | eu:637227 + eu:637228 + us:2390465 + us:2390466 |
| 8 | Dive Into WoW: Forever, the Gods of Zul'Aman, Hallow's End, ... | eu:637232 + us:2390480 + us:2390481 |
| 9 | Watch the WoW: Forever Short Story, "Unbowed" | eu:637597 + us:2392363 |
| 10 | Your Next Adventure in WoW: Forever Starts in the WoW Portal Room | eu:637932 + us:2393349 |
| 11 | New Player's Starter Guide: Welcome to World of Warcraft: Forever | eu:638305 + us:2394974 |
| 13 | Return to Azeroth in World of Warcraft: Forever | eu:638484 + us:2395922 |
| 15 | WoW: Forever, What's New and What Feels Familiar | eu:639257 + us:2400000 |
| 16 | Explore WoW: Forever with a Gamepad | eu:639280 + us:2400119 |

**B. 3 stories that come from the owner-reviewed ALLOW overrides (already reviewed on 2026-11-04/05)**

| # | Story | Threads |
| - | --- | --- |
| 1 | WoW Forever Beta Development Notes (Updated November 2 / 3 November) | eu:631316 + us:2360696 |
| 6 | The WoW: Forever Podcast: Episode 5 - End of Beta Special | eu:637043 + us:2389565 |
| 12 | The WoW: Forever Podcast: Episode 6 - All About Tech | eu:638462 + us:2395799 |

**C. 5 stories matched automatically since the reviewed inventory (NOT covered by the earlier owner review: review these before any write)**

| # | Story | Threads |
| - | --- | --- |
| 14 | World of Warcraft: Forever Now Live! | eu:638503 + us:2396008 |
| 17 | Set Your Campfire Ablaze with the Pouch of Violet Dust! | eu:639571 + us:2401461 |
| 18 | Issues Resolved for Invite-a-Friend Players | eu:639604 + us:2401646 |
| 19 | WoW: Forever, Watch Forging Forever | eu:639841 + us:2402801 + us:2402802 |
| 20 | Prepare for Forever, Try Midnight's Talebound, and Discover Sweet Treats ... | us:2408668 + us:2408677 (two US cross-posts only; the EU thread is a review pair below) |

Check: 12 + 3 + 5 = 20 stories. Threads to link: A = 28, B = 6, C = 11, total 45.

## The 4 review pairs (stay separate)

| Pair | Reason reported |
| --- | --- |
| Roleplay-PvP Ruleset: eu:637031 / us:2389502 | `content_differs_or_excerpt_too_short`, 2.2 min apart |
| Beta Celebration: eu:637055 / us:2389633 | `denied_by_override` (reviewed DENY) and content differs |
| Prepare for Forever ...: eu:641161 / us:2408668 | `content_differs_or_excerpt_too_short`, 8.8 min apart |
| Prepare for Forever ...: eu:641161 / us:2408677 | `content_differs_or_excerpt_too_short`, 0.7 min apart |

## Roleplay-PvP excerpt discrepancy (changed since 2026-11-04)

On 2026-11-04 this pair was a confirmed story. Both openers are by the same author (Aggrend) on 2026-10-22 (EU 15:30:54 UTC, US 15:33:08 UTC). The stored opener excerpts now differ:

| Thread | Opener excerpt length | Ending |
| --- | --- | --- |
| eu:637031 | 307 characters | ends with a literal `&hellip;` (an HTML entity left undecoded) |
| us:2389502 | 420 characters | ends with the `…` character |

Both start with the same text ("Greetings, In a recent episode of the WoW Forever Podcast ..."). The difference is in how the excerpt was stored (truncation length and entity decoding), not in the announcement. The matcher's conservative outcome is two cards. Options (owner decision, none applied): leave it split; add a reviewed ALLOW override for this pair; or re-ingest the EU thread so its excerpt is stored the same way. The undecoded entity also suggests the collector's excerpt normalisation is not identical across regions, which is worth a separate look.

## Risks before any link write

1. Group C (5 stories) was not part of the earlier owner review.
2. The Roleplay-PvP pair stays split unless an override is added.
3. The write is idempotent (`on conflict (thread_key) do nothing`) and reversible by deleting the inserted link rows; source tables are untouched. The rollback script refuses while overrides exist.
4. New cross-region announcements stay two cards until a link run (no cron is configured).
