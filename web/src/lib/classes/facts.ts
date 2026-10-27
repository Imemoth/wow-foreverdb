import { TALENT_MANIFEST } from "@/lib/talents/registry";
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

/** Provenance line shown under every calculator. */
export function talentSourceNote(): string {
  const { build, source } = TALENT_MANIFEST;
  return `Talent structure (names, ranks, grid positions, prerequisites, tier requirements) from the WoW: Forever beta client, build ${build.version}, as extracted by the Everloot project (commit ${source.commit.slice(0, 7)}). Rank descriptions and icons are not included because no verified source is available yet. Beta data: not confirmed for the release client and subject to change.`;
}
