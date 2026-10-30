import {
  EVIDENCE_RANK, VersionedDataError,
  type Baseline, type ChangeFile, type ChangeRecord, type Evidence, type HistoryEntry, type PropDiff, type PropValue, type Props,
  type ResolvedEntity, type ResolvedState, type SourceCatalog, type SourceRef,
} from "./types";

const same = (a: PropValue | undefined, b: PropValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const known = (v: PropValue | undefined) => v !== null && v !== undefined;
/** Structural changes (add / remove / restore) need at least this evidence. */
const STRUCTURAL_RANK = EVIDENCE_RANK.official;

function diffs(before: Props | null, after: Props): PropDiff[] {
  const out: PropDiff[] = [];
  for (const prop of Object.keys(after)) {
    if (!before || !same(before[prop], after[prop])) out.push({ prop, from: before?.[prop], to: after[prop] });
  }
  return out;
}

function sourceIndex(catalog: SourceCatalog): Map<string, SourceRef> {
  const m = new Map<string, SourceRef>();
  for (const s of catalog.sources) {
    if (m.has(s.id)) throw new VersionedDataError("duplicate-source", `source "${s.id}" is defined twice`);
    m.set(s.id, s);
  }
  return m;
}

function pick(index: Map<string, SourceRef>, ids: string[], where: string): SourceRef[] {
  return ids.map((id) => {
    const s = index.get(id);
    if (!s) throw new VersionedDataError("unknown-source", `${where} references source "${id}" which is not defined`);
    return s;
  });
}

/**
 * Deterministically resolve `baseline + change records` into the current definitions.
 *
 * - Records are applied in chronological order (announce date, then record id); the input order does not matter.
 * - Evidence decides per property: a record may only set a property when its evidence is at least as strong as what already
 *   backs that property (an unknown/null value is backed by nothing). `unverified` records never apply. Add / remove / restore
 *   need official-or-better evidence. Whatever cannot be applied is kept as `pending`, never silently dropped or merged in.
 * - Nothing is guessed: a `previous` that disagrees with the resolved state, an unknown entity or a double removal throws a
 *   VersionedDataError instead of picking a side.
 * - The function never mutates its input, and equal inputs give equal (deep-equal) output.
 */
export function resolveVersioned(baseline: Baseline, changeFiles: readonly ChangeFile[], catalog: SourceCatalog): ResolvedState {
  const index = sourceIndex(catalog);
  const ents = new Map<string, ResolvedEntity>();

  for (const b of baseline.entities) {
    if (ents.has(b.id)) throw new VersionedDataError("duplicate-entity", `baseline defines "${b.id}" twice`);
    const props = structuredClone(b.props);
    const propEvidence: Record<string, Evidence> = {};
    for (const [k, v] of Object.entries(props)) if (known(v)) propEvidence[k] = b.propEvidence?.[k] ?? b.evidence;
    const entry: HistoryEntry = {
      recordId: "baseline", type: "baseline", announcedOn: baseline.asOf, effectiveOn: null, build: null, evidence: b.evidence,
      sources: pick(index, b.sources, `baseline entity ${b.id}`), verifiedOn: null,
      summary: `Earliest documented definition (${baseline.title}).`, diffs: diffs(null, props), applied: true, snapshot: structuredClone(props),
    };
    ents.set(b.id, { id: b.id, kind: b.kind, active: true, current: props, propEvidence, history: [entry], pending: [] });
  }

  const records: ChangeRecord[] = [];
  const seen = new Set<string>();
  for (const f of changeFiles) {
    for (const r of f.records) {
      if (seen.has(r.id)) throw new VersionedDataError("duplicate-record", `change record "${r.id}" appears twice`);
      seen.add(r.id);
      records.push(r);
    }
  }
  records.sort((a, b) => a.announcedOn.localeCompare(b.announcedOn) || a.id.localeCompare(b.id));

  let latest = { recordId: "baseline", announcedOn: baseline.asOf };

  for (const r of records) {
    if (r.ops.length === 0) throw new VersionedDataError("empty-record", `record "${r.id}" has no operations`);
    if (r.announcedOn < baseline.asOf) throw new VersionedDataError("bad-order", `record "${r.id}" predates the baseline`);
    const sources = pick(index, r.sources, `record ${r.id}`);
    const rank = EVIDENCE_RANK[r.evidence];

    for (const op of r.ops) {
      const where = `record ${r.id}, ${op.entity}`;
      const entry = (diff: PropDiff[], applied: boolean, snapshot: Props | null): HistoryEntry => ({
        recordId: r.id, type: op.type, announcedOn: r.announcedOn, effectiveOn: r.effectiveOn, build: r.build, evidence: r.evidence,
        sources, verifiedOn: r.verifiedOn, summary: op.summary, notes: r.notes, diffs: diff, applied,
        snapshot: snapshot ? structuredClone(snapshot) : null,
      });
      const cur = ents.get(op.entity);

      if (op.type === "added") {
        if (!op.kind) throw new VersionedDataError("bad-op", `${where}: "added" needs a kind`);
        if (!op.set) throw new VersionedDataError("bad-op", `${where}: "added" needs a property set`);
        if (cur) throw new VersionedDataError("already-exists", `${where}: entity already exists`);
        const props = structuredClone(op.set);
        if (rank < STRUCTURAL_RANK) {
          // A weakly backed addition is remembered as a pending placeholder that is never exposed as current.
          ents.set(op.entity, { id: op.entity, kind: op.kind, active: false, current: props, propEvidence: {}, history: [], pending: [entry(diffs(null, props), false, null)] });
          continue;
        }
        const propEvidence: Record<string, Evidence> = {};
        for (const [k, v] of Object.entries(props)) if (known(v)) propEvidence[k] = r.evidence;
        ents.set(op.entity, { id: op.entity, kind: op.kind, active: true, current: props, propEvidence, history: [entry(diffs(null, props), true, props)], pending: [] });
        latest = { recordId: r.id, announcedOn: r.announcedOn };
        continue;
      }

      if (!cur) throw new VersionedDataError("unknown-entity", `${where}: entity is not defined`);

      if (op.previous) {
        for (const [k, v] of Object.entries(op.previous)) {
          // A null baseline value is "unknown" and cannot contradict anything.
          if (known(cur.current[k]) && !same(cur.current[k], v)) {
            throw new VersionedDataError("conflict", `${where}: expected ${k}=${JSON.stringify(v)} but the resolved value is ${JSON.stringify(cur.current[k])}`);
          }
        }
      }

      if (op.type === "removed" || op.type === "restored") {
        if (rank < STRUCTURAL_RANK) { cur.pending.push(entry([], false, null)); continue; }
        if (op.type === "removed") {
          if (!cur.active) throw new VersionedDataError("already-removed", `${where}: already removed`);
          cur.active = false;
          cur.history.push(entry([], true, cur.current));
        } else {
          if (cur.active) throw new VersionedDataError("not-removed", `${where}: cannot restore an entity that is not removed`);
          const set = structuredClone(op.set ?? {});
          const d = diffs(cur.current, set);
          cur.current = { ...cur.current, ...set };
          for (const [k, v] of Object.entries(set)) if (known(v)) cur.propEvidence[k] = r.evidence;
          cur.active = true;
          cur.history.push(entry(d, true, cur.current));
        }
        latest = { recordId: r.id, announcedOn: r.announcedOn };
        continue;
      }

      // modified / renamed / documented: decided property by property.
      if (!cur.active) throw new VersionedDataError("already-removed", `${where}: cannot change a removed entity (restore it first)`);
      if (!op.set || Object.keys(op.set).length === 0) throw new VersionedDataError("bad-op", `${where}: "${op.type}" needs a property set`);
      const accepted: Props = {};
      const refused: Props = {};
      for (const [k, v] of Object.entries(op.set)) {
        const have = known(cur.current[k]) ? EVIDENCE_RANK[cur.propEvidence[k] ?? "unverified"] : -1;
        if (rank >= 1 && rank >= have) accepted[k] = v;
        else refused[k] = v;
      }
      if (Object.keys(refused).length) cur.pending.push({ ...entry(diffs(null, refused), false, null) });
      if (Object.keys(accepted).length === 0) continue;
      const d = diffs(cur.current, accepted);
      cur.current = { ...cur.current, ...structuredClone(accepted) };
      for (const [k, v] of Object.entries(accepted)) {
        if (known(v)) cur.propEvidence[k] = r.evidence;
        else delete cur.propEvidence[k];
      }
      cur.history.push(entry(d, true, cur.current));
      latest = { recordId: r.id, announcedOn: r.announcedOn };
    }
  }

  const entities = [...ents.values()].filter((e) => e.history.length > 0 || e.pending.length > 0);
  return { entities, byId: new Map(entities.map((e) => [e.id, e])), latest };
}

/** True when the entity has a real (applied) definition, i.e. it is not only a pending proposal. */
export const isEstablished = (e: ResolvedEntity) => e.history.length > 0;
