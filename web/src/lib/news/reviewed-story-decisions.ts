/**
 * Owner-reviewed EU/US story decisions (2026-11-04). They mirror the rows of `pub.news_story_overrides`
 * (thread_a < thread_b, i.e. `eu:` before `us:`) that database/public-read/ops/news_v2_story_overrides_review.sql would insert.
 *
 * THESE ARE DECISIONS, NOT A PRODUCTION WRITE: nothing here is applied to the database. Writing the rows and linking stories each need a
 * separate owner approval after migration 0013 is approved and applied. The evidence per decision is kept in
 * docs/web/evidence/news-story-decisions-2026-11-04.json (exact source topic ids, post ids, titles, timestamps, excerpt fingerprints).
 */
import type { StoryOverride } from "@/lib/news/stories";

export interface ReviewedStoryDecision extends StoryOverride {
  /** Human-readable name of the announcement. */
  story: string;
  reason: string;
}

export const REVIEWED_STORY_DECISIONS: readonly ReviewedStoryDecision[] = [
  {
    story: "WoW Forever Beta Development Notes", threadA: "eu:topic:631316", threadB: "us:topic:2360696", decision: "allow",
    reason: "Verified equivalent announcement by the same author with an identical 420-character opener; the titles differ only in the date wording (Updated November 2 / Updated 3 November).",
  },
  {
    story: "The WoW: Forever Podcast: Episode 5 - End of Beta Special", threadA: "eu:topic:637043", threadB: "us:topic:2389565", decision: "allow",
    reason: "Same episode, same author, published 47 seconds apart; the opener carries no excerpt, equivalence was verified against the live US and EU sources.",
  },
  {
    story: "The WoW: Forever Podcast: Episode 6 - All About Tech", threadA: "eu:topic:638462", threadB: "us:topic:2395799", decision: "allow",
    reason: "Same episode, same author, published 28 seconds apart; the opener carries no excerpt, equivalence was verified against the live US and EU sources.",
  },
  {
    story: "The WoW Forever Beta Celebration is Underway", threadA: "eu:topic:637055", threadB: "us:topic:2389633", decision: "deny",
    reason: "Region-specific announcement: the event times and wording differ between the US and the EU posts, so the regional versions are preserved as separate cards.",
  },
];

export const REVIEWED_STORY_OVERRIDES: StoryOverride[] = REVIEWED_STORY_DECISIONS.map(({ threadA, threadB, decision }) => ({ threadA, threadB, decision }));
