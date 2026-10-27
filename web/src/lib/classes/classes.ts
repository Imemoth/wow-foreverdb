import { getTalentData } from "@/lib/talents/registry";
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

export const CLASSES: readonly ClassInfo[] = [
  { id: "warrior", name: "Warrior", color: "#C79C6E" },
  { id: "paladin", name: "Paladin", color: "#F58CBA" },
  { id: "hunter", name: "Hunter", color: "#ABD473" },
  { id: "rogue", name: "Rogue", color: "#FFF569" },
  { id: "priest", name: "Priest", color: "#FFFFFF" },
  { id: "shaman", name: "Shaman", color: "#0070DE" },
  { id: "mage", name: "Mage", color: "#69CCF0" },
  { id: "warlock", name: "Warlock", color: "#9482C9" },
  { id: "druid", name: "Druid", color: "#FF7D0A" },
];

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
