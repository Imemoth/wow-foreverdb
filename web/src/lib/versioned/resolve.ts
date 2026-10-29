import {
  APPLIED_EVIDENCE, VersionedDataError,
  type Baseline, type ChangeFile, type ChangeRecord, type HistoryEntry, type PropDiff, type PropValue, type Props, type ResolvedEntity,
  type ResolvedState, type SourceRef,
} from "./types";

const same = (a: PropValue | undefined, b: PropValue | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffs(before: Props | null, after: Props): PropDiff[] {
  const out: PropDiff[] = [];
  for (const prop of Object.keys(after)) {
    if (!before || !same(before[prop], after[prop])) out.push({ prop, from: before?.[prop], to: after[prop] });
  }
  return out;
}

function sourceIndex(files: ReadonlyArray<{ sources: SourceRef[] }>): Map<string, SourceRef> {
  const m = new Map<string, SourceRef>();
  for (const f of files) for (const s of f.sources) m.set(s.id, s);
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
 * - Only records with applied evidence (client-verified / official) change the state; weaker records are returned as `pending`.
 * - Nothing is guessed: a `previous` that disagrees with the resolved state, an unknown entity or a double removal throws a
 *   VersionedDataError instead of picking a side.
 * - The function never mutates its input, and equal inputs give equal (deep-equal) output.
 */
export function resolveVersioned(baseline: Baseline, changeFiles: readonly ChangeFile[]): ResolvedState {
  const index = sourceIndex([baseline, ...changeFiles]);
  const ents = new Map<string, ResolvedEntity>();

  for (const b of baseline.entities) {
    if (ents.has(b.id)) throw new VersionedDataError("duplicate-entity", `baseline defines "${b.id}" twice`);
    const props = structuredClone(b.props);
    const entry: HistoryEntry = {
      recordId: "baseline", type: "baseline", announcedOn: baseline.asOf, effectiveOn: null, build: null, evidence: "official",
      sources: pick(index, b.sources, `baseline entity ${b.id}`), verifiedOn: null,
      summary: `Documented in ${baseline.title}.`, diffs: diffs(null, props), applied: true, snapshot: structuredClone(props),
    };
    ents.set(b.id, { id: b.id, kind: b.kind, active: true, current: props, history: [entry], pending: [] });
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
    const applies = APPLIED_EVIDENCE.includes(r.evidence);

    for (const op of r.ops) {
      const where = `record ${r.id}, ${op.entity}`;
      const make = (props: Props | null, applied: boolean): HistoryEntry => ({
        recordId: r.id, type: op.type, announcedOn: r.announcedOn, effectiveOn: r.effectiveOn, build: r.build, evidence: r.evidence,
        sources, verifiedOn: r.verifiedOn, summary: op.summary, notes: r.notes, diffs: diffs(null, op.set ?? {}), applied,
        snapshot: props ? structuredClone(props) : null,
      });
      const cur = ents.get(op.entity);

      if (op.type === "added") {
        if (!op.kind) throw new VersionedDataError("bad-op", `${where}: "added" needs a kind`);
        if (!op.set) throw new VersionedDataError("bad-op", `${where}: "added" needs a property set`);
        if (cur) throw new VersionedDataError("already-exists", `${where}: entity already exists`);
        if (!applies) {
          // A pending addition is remembered on a placeholder that is never exposed as current.
          ents.set(op.entity, { id: op.entity, kind: op.kind, active: false, current: structuredClone(op.set), history: [], pending: [make(null, false)] });
          continue;
        }
        const props = structuredClone(op.set);
        ents.set(op.entity, { id: op.entity, kind: op.kind, active: true, current: props, history: [make(props, true)], pending: [] });
        latest = { recordId: r.id, announcedOn: r.announcedOn };
        continue;
      }

      if (!cur) throw new VersionedDataError("unknown-entity", `${where}: entity is not defined`);

      if (!applies) {
        cur.pending.push(make(null, false));
        continue;
      }

      if (op.previous) {
        for (const [k, v] of Object.entries(op.previous)) {
          // A null baseline value is "unknown" and cannot contradict anything.
          if (cur.current[k] !== null && cur.current[k] !== undefined && !same(cur.current[k], v)) {
            throw new VersionedDataError("conflict", `${where}: expected ${k}=${JSON.stringify(v)} but the resolved value is ${JSON.stringify(cur.current[k])}`);
          }
        }
      }

      switch (op.type) {
        case "removed":
          if (!cur.active) throw new VersionedDataError("already-removed", `${where}: already removed`);
          cur.active = false;
          cur.history.push({ ...make(cur.current, true), diffs: [] });
          break;
        case "restored":
          if (cur.active) throw new VersionedDataError("not-removed", `${where}: cannot restore an entity that is not removed`);
          cur.current = { ...cur.current, ...structuredClone(op.set ?? {}) };
          cur.active = true;
          cur.history.push({ ...make(cur.current, true), diffs: diffs(null, op.set ?? {}) });
          break;
        case "modified":
        case "renamed": {
          if (!cur.active) throw new VersionedDataError("already-removed", `${where}: cannot modify a removed entity (restore it first)`);
          if (!op.set || Object.keys(op.set).length === 0) throw new VersionedDataError("bad-op", `${where}: "${op.type}" needs a property set`);
          const d = diffs(cur.current, op.set);
          cur.current = { ...cur.current, ...structuredClone(op.set) };
          cur.history.push({ ...make(cur.current, true), diffs: d });
          break;
        }
      }
      latest = { recordId: r.id, announcedOn: r.announcedOn };
    }
  }

  // Drop placeholders that only ever had a pending addition from the exposed state but keep their pending trail.
  const entities = [...ents.values()].filter((e) => e.history.length > 0 || e.pending.length > 0);
  return { entities, byId: new Map(entities.map((e) => [e.id, e])), latest };
}

/** True when the entity has a real (applied) definition, i.e. it is not only a pending proposal. */
export const isEstablished = (e: ResolvedEntity) => e.history.length > 0;
