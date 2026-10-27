import { z } from "../zod";
import type { TalentClassData } from "./types";

const talent = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(80),
    spellId: z.number().int().positive(),
    row: z.number().int().min(0).max(15),
    col: z.number().int().min(0).max(7),
    maxRank: z.number().int().min(1).max(9),
    pointsRequired: z.number().int().min(1).max(100).optional(),
    pointsRequiredScope: z.enum(["tree", "assumed-tree"]).optional(),
    requires: z
      .array(z.object({ talentId: z.number().int().positive(), rule: z.enum(["all", "any"]), minRank: z.number().int().min(1).optional() }).strict())
      .optional(),
    descriptions: z.array(z.string().min(1)).optional(),
    description: z.string().min(1).max(1200).optional(),
  })
  .strict();

const tree = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1).max(40),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    rows: z.number().int().min(1).max(16),
    cols: z.number().int().min(1).max(8),
    talents: z.array(talent).min(1),
  })
  .strict();

export const TalentClassSchema = z
  .object({
    schema: z.literal("azerdex.talent-class/1"),
    classId: z.string().regex(/^[a-z]+$/),
    className: z.string().min(2).max(20),
    gameClassId: z.number().int().positive(),
    build: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/), buildId: z.number().int().positive() }).strict(),
    pointBudget: z
      .object({ total: z.number().int().positive(), firstPointLevel: z.number().int().positive(), lastPointLevel: z.number().int().positive() })
      .strict(),
    trees: z.array(tree).min(1).max(5),
  })
  .strict();

/** Structural checks the field schema cannot express. Returns human-readable problems (empty = valid). */
export function validateTalentClass(data: TalentClassData): string[] {
  const problems: string[] = [];
  const treeIds = new Set<number>();
  const talentIds = new Set<number>();
  for (const t of data.trees) {
    if (treeIds.has(t.id)) problems.push(`duplicate tree id ${t.id}`);
    treeIds.add(t.id);
    const cells = new Set<string>();
    const local = new Map(t.talents.map((x) => [x.id, x]));
    let prev = -1;
    for (const x of t.talents) {
      if (talentIds.has(x.id)) problems.push(`duplicate talent id ${x.id}`);
      talentIds.add(x.id);
      const cell = `${x.row}:${x.col}`;
      if (cells.has(cell)) problems.push(`${t.name}: two talents at row ${x.row} col ${x.col}`);
      cells.add(cell);
      const order = x.row * 100 + x.col;
      if (order < prev) problems.push(`${t.name}: talents not sorted by row, column at ${x.name}`);
      prev = order;
      if (x.row >= t.rows || x.col >= t.cols) problems.push(`${t.name}/${x.name}: outside the ${t.rows}x${t.cols} grid`);
      if ((x.pointsRequired === undefined) !== (x.pointsRequiredScope === undefined)) problems.push(`${t.name}/${x.name}: pointsRequired and its scope must be set together`);
      if (x.descriptions && x.descriptions.length !== x.maxRank) problems.push(`${t.name}/${x.name}: needs ${x.maxRank} rank descriptions`);
      for (const r of x.requires ?? []) {
        const target = local.get(r.talentId);
        if (!target) problems.push(`${t.name}/${x.name}: requires ${r.talentId}, which is not in this tree`);
        else {
          if (target.id === x.id) problems.push(`${t.name}/${x.name}: requires itself`);
          if (r.minRank !== undefined && r.minRank > target.maxRank) problems.push(`${t.name}/${x.name}: minRank ${r.minRank} exceeds ${target.name}'s max rank`);
        }
      }
    }
  }
  return problems;
}
