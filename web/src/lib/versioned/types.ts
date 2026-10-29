/**
 * Append-only, source-backed version history for game definitions (V1: racial abilities; reusable for class abilities later).
 *
 * Model: `baseline` (what one dated source documented) + chronological `change records` = current definitions.
 * Nothing is stored twice: the current state is always *derived* by `resolveVersioned` and every historical value stays
 * reachable through the entity's history. An unknown value is `null`, never a guess.
 */

export type Scalar = string | number | boolean | null;
/** A property value. `null` means "not documented / unknown" (never "zero" or "none"). */
export type PropValue = Scalar | Scalar[];
export type Props = Record<string, PropValue>;

/** Date-only ISO string (YYYY-MM-DD). */
export type IsoDate = string;

export type SourceKind = "client-data" | "official-dev-notes" | "official-article" | "community";

export interface SourceRef {
  /** Stable id, referenced by baselines and change records of the same file. */
  id: string;
  url: string;
  title: string;
  publisher: string;
  kind: SourceKind;
  /** Publication date of the source (when the text was published, not when anything changed in game). */
  publishedOn: IsoDate;
  /** When AzerDex last read this source. */
  retrievedOn: IsoDate;
}

/**
 * How well a statement is backed. Priority follows the project's source order:
 * client-verified (a named client build) > official (Blizzard patch/dev notes or overview articles) >
 * corroborated (independent community sources) > unverified.
 * Only `client-verified` and `official` records change the current state; the other two are listed as pending, never applied.
 */
export type Evidence = "client-verified" | "official" | "corroborated" | "unverified";
export const APPLIED_EVIDENCE: readonly Evidence[] = ["client-verified", "official"];

export type ChangeType = "added" | "modified" | "renamed" | "removed" | "restored";

export interface BaselineEntity {
  id: string;
  kind: string;
  props: Props;
  /** Source ids (from the baseline file) documenting this entity. */
  sources: string[];
}

export interface Baseline {
  schema: "azerdex.versioned-baseline/1";
  /** Publication date of the baseline source(s). */
  asOf: IsoDate;
  title: string;
  sources: SourceRef[];
  entities: BaselineEntity[];
}

export interface ChangeOp {
  entity: string;
  type: ChangeType;
  /** Required for `added`: the entity kind. */
  kind?: string;
  /** New values of the changed properties (the full property set for `added` / `restored`). */
  set?: Props;
  /** Values the author saw before this change. When present they must equal the resolved state (a mismatch is a conflict). */
  previous?: Props;
  /** One plain-English sentence for players. */
  summary: string;
}

export interface ChangeRecord {
  id: string;
  /** Publication date of the evidence. Not necessarily the in-game effective date. */
  announcedOn: IsoDate;
  /** When the change became live in game; null while that cannot be established. */
  effectiveOn: IsoDate | null;
  /** Client build the change is verified against; null unless independently supported. */
  build: string | null;
  evidence: Evidence;
  /** Source ids (from the file's `sources`). At least one. */
  sources: string[];
  /** When the record was checked against its sources. */
  verifiedOn: IsoDate;
  notes?: string;
  ops: ChangeOp[];
}

export interface ChangeFile {
  schema: "azerdex.versioned-changes/1";
  title: string;
  sources: SourceRef[];
  records: ChangeRecord[];
}

export interface PropDiff {
  prop: string;
  from: PropValue | undefined;
  to: PropValue | undefined;
}

export interface HistoryEntry {
  /** Change record id, or "baseline". */
  recordId: string;
  type: ChangeType | "baseline";
  announcedOn: IsoDate;
  effectiveOn: IsoDate | null;
  build: string | null;
  evidence: Evidence;
  sources: SourceRef[];
  verifiedOn: IsoDate | null;
  summary: string;
  notes?: string;
  diffs: PropDiff[];
  /** False for pending records (not strong enough evidence to replace confirmed values). */
  applied: boolean;
  /** The full property set after this entry (applied entries only); lets the UI show earlier definitions. */
  snapshot: Props | null;
}

export interface ResolvedEntity {
  id: string;
  kind: string;
  /** False after a `removed` change (until `restored`). Inactive entities keep their last definition in `current`. */
  active: boolean;
  current: Props;
  history: HistoryEntry[];
  pending: HistoryEntry[];
}

export interface ResolvedState {
  entities: ResolvedEntity[];
  byId: ReadonlyMap<string, ResolvedEntity>;
  /** Id of the newest applied record (or "baseline"), with its announce date. */
  latest: { recordId: string; announcedOn: IsoDate };
}

export type VersionedErrorCode =
  | "duplicate-entity" | "unknown-entity" | "already-removed" | "not-removed" | "already-exists" | "conflict"
  | "unknown-source" | "bad-order" | "duplicate-record" | "empty-record" | "bad-op";

export class VersionedDataError extends Error {
  constructor(readonly code: VersionedErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "VersionedDataError";
  }
}
