import { CLASS_COLORS } from "@/lib/classes/colors";

/**
 * Presentation data for editorial "feature" articles: a kicker above the headline, a three-stat strip under the hero
 * and a roster of named people. It is keyed by article slug, exactly like SLUG_COVER_ART in article-media.ts, so the
 * Markdown stays plain prose (no raw HTML) and a typo fails a unit test rather than silently dropping the treatment.
 * Everything here restates facts the article's own Markdown and cited sources already carry.
 *
 * In the article body the roster renders where the `<!-- feature:roster -->` marker sits (see splitAtRosterMarker).
 */
export interface FeatureStat { value: string; label: string }
export interface FeatureRosterEntry { name: string; classId: "mage" | "paladin" | "shaman"; className: string; race: string; color: string }
export interface FeatureArticle {
  /** The cover is a finished poster (headline and badges baked in): show it uncropped, with no scrim or text over it. */
  poster?: boolean;
  kicker: string;
  stats: readonly FeatureStat[];
  rosterTitle: string;
  roster: readonly FeatureRosterEntry[];
}

export const ROSTER_MARKER = "<!-- feature:roster -->";

const entry = (name: string, classId: FeatureRosterEntry["classId"], className: string, race: string): FeatureRosterEntry =>
  ({ name, classId, className, race, color: CLASS_COLORS[classId]! });

export const SLUG_FEATURE: Record<string, FeatureArticle> = {
  "jokerd-team-world-first-level-60-wow-forever": {
    poster: true,
    kicker: "World First — Level 60",
    stats: [
      { value: "52", label: "Hours" },
      { value: "5", label: "Players" },
      { value: "60", label: "Level" },
    ],
    rosterTitle: "Team Jokerd — Horde, EU Normal",
    roster: [
      entry("Jokerd Prime", "mage", "Mage", "Undead"),
      entry("Burning Speed", "mage", "Mage", "Undead"),
      entry("Vitochie Gofast", "mage", "Mage", "Undead"),
      entry("Cloud Bells", "paladin", "Paladin", "Undead"),
      entry("Lmgd Mmr", "shaman", "Shaman", "Troll"),
    ],
  },
};

/** Splits an article body around the roster marker; `after` is null when the article has no marker. */
export function splitAtRosterMarker(body: string): { before: string; after: string | null } {
  const i = body.indexOf(ROSTER_MARKER);
  if (i === -1) return { before: body, after: null };
  return { before: body.slice(0, i), after: body.slice(i + ROSTER_MARKER.length) };
}
