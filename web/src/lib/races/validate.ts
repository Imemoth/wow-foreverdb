import { CLASSES } from "../classes/classes";
import type { RaceGuide } from "./types";

/** Structural rules every shipped race dataset must satisfy; returns human-readable problems (empty = valid). */
export function validateRaceGuides(guides: readonly RaceGuide[]): string[] {
  const problems: string[] = [];
  const classIds = new Set(CLASSES.map((c) => c.id));
  if (guides.length !== 10) problems.push(`expected 10 race entries, found ${guides.length}`);
  for (const f of ["alliance", "horde"] as const) {
    const n = guides.filter((g) => g.faction === f).length;
    if (n !== 5) problems.push(`expected 5 ${f} entries, found ${n}`);
  }
  const seenSlugs = new Set<string>();
  const seenAbilities = new Set<string>();
  for (const g of guides) {
    if (seenSlugs.has(g.slug)) problems.push(`duplicate race slug ${g.slug}`);
    seenSlugs.add(g.slug);
    if (g.active.length !== 2) problems.push(`${g.id}: expected 2 active abilities, found ${g.active.length}`);
    if (g.passive.length !== 2) problems.push(`${g.id}: expected 2 passive abilities, found ${g.passive.length}`);
    if (g.classes.length === 0) problems.push(`${g.id}: no classes documented`);
    for (const c of g.classes) if (!classIds.has(c.classId)) problems.push(`${g.id}: unknown class ${c.classId}`);
    if (new Set(g.classes.map((c) => c.classId)).size !== g.classes.length) problems.push(`${g.id}: duplicate class`);
    const names = new Set<string>();
    for (const a of [...g.active, ...g.passive]) {
      if (names.has(a.name)) problems.push(`${g.id}: duplicate current ability name ${a.name}`);
      names.add(a.name);
      if (!a.active) problems.push(`${g.id}: removed ability ${a.id} is listed as current`);
      if (a.sources.length === 0) problems.push(`${a.id}: no source`);
      if (!a.description) problems.push(`${a.id}: no description`);
      seenAbilities.add(a.id);
    }
  }
  return problems;
}
