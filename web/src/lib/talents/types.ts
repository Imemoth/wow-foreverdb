/**
 * Versioned talent data contract ("azerdex.talent-class/1"). One file per class, produced by
 * scripts/import-talent-catalog.mjs and validated by schema.ts. The calculator UI only ever reads this shape,
 * so data can be refreshed (or another game version added) without touching components.
 */

export interface TalentPrerequisite {
  /** Another talent of the same tree. */
  talentId: number;
  /** "all": always required. "any": at least one of the talents listed with "any" is required. */
  rule: "all" | "any";
  /** Rank the required talent must have. Omitted = the required talent's maximum rank. */
  minRank?: number;
}

export interface Talent {
  id: number;
  name: string;
  /** Game spell id of the talent, shown so entries can be verified against the client. */
  spellId: number;
  row: number;
  col: number;
  maxRank: number;
  /** Points that must already be spent in this tree on rows above this talent. Absent on the first row. */
  pointsRequired?: number;
  /**
   * "tree": the client data shows the points are counted inside this talent tree.
   * "assumed-tree": the client data gives the amount but not where points are counted; applied per tree
   * like every confirmed gate, and flagged to the user.
   */
  pointsRequiredScope?: "tree" | "assumed-tree";
  requires?: TalentPrerequisite[];
  /**
   * Verified description text per rank (index 0 = rank 1), resolved (no $ tokens). Never written by hand: it is merged in
   * from text.json by applyTalentText, and only when that file's build equals the dataset build. When present it has
   * maxRank entries.
   */
  descriptions?: string[];
  /** One resolved description for the whole talent, for sources that do not provide per-rank text. */
  description?: string;
}

export interface TalentTree {
  id: number;
  name: string;
  slug: string;
  rows: number;
  cols: number;
  /** Sorted by row, then column. The order defines the build code, so it is part of the data contract. */
  talents: Talent[];
}

export interface TalentClassData {
  schema: "azerdex.talent-class/1";
  classId: string;
  className: string;
  gameClassId: number;
  build: { version: string; buildId: number };
  /** Total points from the client's point-level table (one point per level from firstPointLevel to lastPointLevel). */
  pointBudget: { total: number; firstPointLevel: number; lastPointLevel: number };
  trees: TalentTree[];
}

export interface TalentManifest {
  schema: "azerdex.talent-manifest/1";
  game: string;
  build: { version: string; buildId: number; buildConfig: string; extractedAt: string; tableDefinitions: string };
  source: {
    name: string;
    repository: string;
    commit: string;
    path: string;
    schema: string;
    label: string;
    note: string;
    sha256: Record<string, string>;
  };
  output: { sha256: Record<string, string> };
}

/** Optional text overlay (text.json), produced by the client extraction and merged by applyTalentText. */
export interface TalentTextFile {
  schema: "azerdex.talent-text/1";
  /** Game build the text was extracted from. null = no text available. Must equal the dataset build to be used. */
  build: string | null;
  source: { name: string; reference: string; extractedAt: string } | null;
  /** By talent id (string keys in JSON). Resolved text only. */
  talents: Record<string, { descriptions?: string[]; description?: string }>;
}

/** Optional icon overlay (icons.json): talent spell id -> client icon file data id. Images are never in git. */
export interface TalentIconManifest {
  schema: "azerdex.talent-icons/1";
  /** Game build the icon ids were read from. null = none. Must equal the dataset build to be used. */
  build: string | null;
  icons: Record<string, number>;
}

/** Allocated ranks by talent id. Talents without points are absent. */
export type Allocation = Readonly<Record<number, number>>;
