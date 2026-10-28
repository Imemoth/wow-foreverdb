import { getTextStatus, TALENT_MANIFEST } from "@/lib/talents/registry";
import type { TalentClassData, TalentTree } from "@/lib/talents/types";

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const treeTalentCount = (t: TalentTree) => t.talents.length;
export const treeRankCount = (t: TalentTree) => t.talents.reduce((s, x) => s + x.maxRank, 0);

/** The short class description. Only facts that are in the verified data - nothing about gameplay is asserted. */
export function classIntro(className: string, data: TalentClassData | null): string {
  if (!data) return `${className} talent data is not available yet. AzerDex only publishes talent trees that have been verified against the game data.`;
  const { total, firstPointLevel, lastPointLevel } = data.pointBudget;
  return `${className} has ${data.trees.length} talent trees in WoW: Forever - ${joinNames(data.trees.map((t) => t.name))}. Talent points arrive one per level from level ${firstPointLevel} to level ${lastPointLevel}: ${total} points in total, shared across all three trees.`;
}

/**
 * Provenance line shown under every calculator: where the structure comes from and exactly what is and is not present
 * (description text, icons), so the page never implies more than the data supports.
 */
export function talentSourceNote(classId: string, iconCount = 0, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const { build, source } = TALENT_MANIFEST;
  const text = getTextStatus(classId, env);
  const parts = [
    `Talent structure (names, ranks, grid positions, prerequisites, tier requirements) from the WoW: Forever beta client, build ${build.version}, as extracted by the Everloot project (commit ${source.commit.slice(0, 7)}).`,
    "Talent names, description text and icons are World of Warcraft game content (c) Blizzard Entertainment, Inc.; AzerDex is an independent fan site and is not affiliated with or endorsed by Blizzard.",
  ];
  if (text.state === "none" && iconCount === 0) {
    parts.push("Rank descriptions and icons are not included because no verified, build-matched source is available yet.");
  } else {
    if (text.state === "applied") {
      parts.push(
        `Descriptions: ${text.source.name}, build ${text.build} (client data extracted ${text.source.extractedAt}). ${text.covered} of ${text.total} talents have a verified description and ${text.complete} of them have every number resolved; "?" marks a number that is not available for this build yet. The other ${text.total - text.covered} have no verified description.`,
      );
    } else if (text.state === "withheld") parts.push("Description text is withheld on this deployment.");
    else if (text.state === "mismatch") parts.push(`Description text supplied for build ${text.textBuild ?? "unknown"} was ignored because it does not match build ${build.version}.`);
    else parts.push("Rank descriptions are not included because no verified, build-matched source is available yet.");
    parts.push(iconCount > 0 ? `Icons: Blizzard client art for ${iconCount} talents, read from the same client build (${build.version}) and served from the AzerDex asset host.` : "Icons are not included; talents show their names.");
  }
  parts.push("Beta data: not confirmed for the release client and subject to change.");
  return parts.join(" ");
}
