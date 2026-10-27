import type { TalentClassData } from "@/lib/talents/types";

/**
 * SYNTHETIC test data. Names, ranks and layout are invented to exercise every rule of the engine
 * (tier gates, full-rank and minRank prerequisites, "any" prerequisites, shared budget across trees).
 * It is never imported by application code and must never be shown to users as WoW: Forever data.
 */
export const SYNTHETIC: TalentClassData = {
  schema: "azerdex.talent-class/1",
  classId: "test",
  className: "Synthetic",
  gameClassId: 99,
  build: { version: "0.0.0.1", buildId: 1 },
  pointBudget: { total: 12, firstPointLevel: 10, lastPointLevel: 21 },
  trees: [
    {
      id: 1,
      name: "Tree A",
      slug: "tree-a",
      rows: 3,
      cols: 2,
      talents: [
        { id: 11, name: "A1", spellId: 1001, row: 0, col: 0, maxRank: 3 },
        { id: 12, name: "A2", spellId: 1002, row: 0, col: 1, maxRank: 2 },
        { id: 13, name: "A3", spellId: 1003, row: 1, col: 0, maxRank: 2, pointsRequired: 3, pointsRequiredScope: "tree" },
        {
          id: 14, name: "A4", spellId: 1004, row: 1, col: 1, maxRank: 1, pointsRequired: 3, pointsRequiredScope: "tree",
          requires: [{ talentId: 12, rule: "all" }],
        },
        {
          id: 15, name: "A5", spellId: 1005, row: 2, col: 0, maxRank: 1, pointsRequired: 5, pointsRequiredScope: "tree",
          requires: [{ talentId: 13, rule: "any" }, { talentId: 14, rule: "any" }],
        },
        {
          id: 16, name: "A6", spellId: 1006, row: 2, col: 1, maxRank: 2, pointsRequired: 5, pointsRequiredScope: "assumed-tree",
          requires: [{ talentId: 11, rule: "all", minRank: 2 }],
        },
      ],
    },
    {
      id: 2,
      name: "Tree B",
      slug: "tree-b",
      rows: 4,
      cols: 1,
      talents: [
        { id: 21, name: "B1", spellId: 2001, row: 0, col: 0, maxRank: 5 },
        { id: 22, name: "B2", spellId: 2002, row: 1, col: 0, maxRank: 1, pointsRequired: 5, pointsRequiredScope: "tree" },
        // B3 and B4 depend on each other (like a client edge pair that points both ways); only B2 can open them.
        { id: 23, name: "B3", spellId: 2003, row: 2, col: 0, maxRank: 1, requires: [{ talentId: 24, rule: "any" }, { talentId: 22, rule: "any" }] },
        { id: 24, name: "B4", spellId: 2004, row: 3, col: 0, maxRank: 1, requires: [{ talentId: 23, rule: "any" }] },
      ],
    },
  ],
};
