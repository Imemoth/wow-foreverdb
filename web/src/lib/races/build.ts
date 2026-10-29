import { CLASSES } from "../classes/classes";
import type { HistoryEntry, PropValue, ResolvedEntity, ResolvedState, SourceRef } from "../versioned/types";
import type { AbilityView, ClassAvailability, Faction, RaceGuide } from "./types";

export interface RaceIdentity {
  id: string;
  name: string;
  faction: Faction;
  /** Original AzerDex wording; never copied from another site. */
  summary: string;
}

const str = (v: PropValue | undefined): string | null => (typeof v === "string" ? v : null);
const strs = (v: PropValue | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function uniqueSources(entity: ResolvedEntity): SourceRef[] {
  const m = new Map<string, SourceRef>();
  for (const h of [...entity.history, ...entity.pending]) for (const s of h.sources) m.set(s.url, s);
  return [...m.values()];
}

export function abilityView(e: ResolvedEntity): AbilityView {
  const p = e.current;
  return {
    id: e.id,
    name: str(p.name) ?? e.id,
    type: p.type === "passive" ? "passive" : "active",
    description: str(p.description) ?? "",
    cooldown: str(p.cooldown),
    duration: str(p.duration),
    details: strs(p.details),
    races: strs(p.races),
    active: e.active,
    history: e.history,
    sources: uniqueSources(e),
  };
}

const className = (id: string) => CLASSES.find((c) => c.id === id)?.name ?? id;

/** Build the per-race view models from a resolved state. Pure and deterministic. */
export function buildRaceGuides(state: ResolvedState, identities: readonly RaceIdentity[]): RaceGuide[] {
  const abilities = state.entities.filter((e) => e.kind === "ability" && e.history.length > 0).map(abilityView);
  return identities.map((id) => {
    const race = state.byId.get(`race.${id.id}`);
    const mine = abilities.filter((a) => a.races.includes(id.id));
    const current = mine.filter((a) => a.active);
    const newIds = new Set(strs(race?.current.newClasses));
    const classes: ClassAvailability[] = strs(race?.current.classes).map((c) => ({ classId: c, name: className(c), isNew: newIds.has(c) }));
    const changes: Array<{ ability: AbilityView; entry: HistoryEntry }> = [];
    for (const a of mine) for (const entry of a.history) if (entry.recordId !== "baseline") changes.push({ ability: a, entry });
    changes.sort((x, y) => y.entry.announcedOn.localeCompare(x.entry.announcedOn) || x.ability.name.localeCompare(y.ability.name));
    const every = mine.flatMap((a) => a.history.filter((h) => h.recordId !== "baseline"));
    const pending = state.entities.filter((e) => e.kind === "ability" && strs(e.current.races).includes(id.id)).reduce((n, e) => n + e.pending.length, 0);
    return {
      id: id.id, slug: id.id, name: id.name, faction: id.faction, summary: id.summary, classes,
      active: current.filter((a) => a.type === "active"), passive: current.filter((a) => a.type === "passive"),
      retired: mine.filter((a) => !a.active),
      changes,
      latestUpdate: every.length ? every.map((h) => h.announcedOn).sort().at(-1)! : null,
      evidence: {
        clientVerified: every.filter((h) => h.evidence === "client-verified").length,
        official: current.length + every.filter((h) => h.evidence === "official").length,
        pending,
      },
    };
  });
}
