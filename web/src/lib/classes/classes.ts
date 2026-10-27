import { getTalentData } from "@/lib/talents/registry";
import { CLASS_COLORS } from "./colors";
import type { TalentTree } from "@/lib/talents/types";

/**
 * Class identity for the Class Guides. Only facts that never change between game versions live here (name, the
 * traditional class colour); everything about talents comes from the versioned talent data, and nothing about
 * gameplay is stated without a verified source.
 */
export interface ClassInfo {
  id: string;
  name: string;
  /** Traditional WoW class colour, used for decorative accents only (text stays in the AzerDex palette for contrast). */
  color: string;
}

const NAMES: ReadonlyArray<readonly [string, string]> = [
  ["warrior", "Warrior"], ["paladin", "Paladin"], ["hunter", "Hunter"], ["rogue", "Rogue"], ["priest", "Priest"],
  ["shaman", "Shaman"], ["mage", "Mage"], ["warlock", "Warlock"], ["druid", "Druid"],
];

export const CLASSES: readonly ClassInfo[] = NAMES.map(([id, name]) => ({ id, name, color: CLASS_COLORS[id]! }));

export function getClass(id: string): ClassInfo | null {
  return CLASSES.find((c) => c.id === id) ?? null;
}

/**
 * Specialization URL segments. Defaults to the talent tree's own slug; the few trees whose in-game name differs
 * from the short name players use get an explicit alias so URLs stay short and stable.
 */
const SPEC_ALIAS: Record<string, string> = {
  "priest/shadow-magic": "shadow",
};

export function specSlug(classId: string, tree: Pick<TalentTree, "slug">): string {
  return SPEC_ALIAS[`${classId}/${tree.slug}`] ?? tree.slug;
}

export interface SpecInfo {
  slug: string;
  tree: TalentTree;
}

export function getSpecs(classId: string): SpecInfo[] {
  const data = getTalentData(classId);
  return data ? data.trees.map((tree) => ({ slug: specSlug(classId, tree), tree })) : [];
}

export function getSpec(classId: string, slug: string): SpecInfo | null {
  return getSpecs(classId).find((s) => s.slug === slug) ?? null;
}

export const classPath = (classId: string) => `/guides/classes/${classId}`;
export const specPath = (classId: string, slug: string) => `/guides/classes/${classId}/${slug}`;
