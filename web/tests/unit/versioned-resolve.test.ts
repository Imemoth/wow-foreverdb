import { describe, expect, it } from "vitest";
import { BaselineSchema, ChangeFileSchema, SourceCatalogSchema } from "@/lib/versioned/schema";
import { resolveVersioned } from "@/lib/versioned/resolve";
import { VersionedDataError, type Baseline, type ChangeFile, type ChangeRecord, type SourceCatalog } from "@/lib/versioned/types";

// Synthetic fixtures: invented names and numbers that exist only in this test file.
const SRC = (id: string, publishedOn: string) => ({
  id, url: `https://example.com/${id}`, title: `Synthetic source ${id}`, publisher: "Test", kind: "official-article" as const, publishedOn, retrievedOn: "2026-10-29",
});
const catalog: SourceCatalog = { schema: "azerdex.versioned-sources/1", sources: [SRC("base", "2026-09-22"), SRC("c", "2026-10-15")] };
const baseline: Baseline = {
  schema: "azerdex.versioned-baseline/1", asOf: "2026-09-22", title: "Synthetic baseline",
  entities: [
    { id: "a.one", kind: "ability", evidence: "official", props: { name: "One", value: 2, unknownThing: null }, sources: ["base"] },
    { id: "a.two", kind: "ability", evidence: "official", props: { name: "Two", value: 5 }, sources: ["base"] },
  ],
};
const rec = (over: Partial<ChangeRecord> & Pick<ChangeRecord, "id" | "ops">): ChangeRecord => ({
  announcedOn: "2026-10-15", effectiveOn: null, build: null, evidence: "official", sources: ["c"], verifiedOn: "2026-10-29", ...over,
});
const file = (...records: ChangeRecord[]): ChangeFile => ({ schema: "azerdex.versioned-changes/1", title: "Synthetic", records });
const mod = (entity: string, set: Record<string, string | number>, previous?: Record<string, string | number>) =>
  ({ entity, type: "modified" as const, set, previous, summary: "Synthetic change summary." });

describe("resolveVersioned", () => {
  it("resolves a baseline with no changes", () => {
    const s = resolveVersioned(baseline, [], catalog);
    expect(s.entities.map((e) => e.id)).toEqual(["a.one", "a.two"]);
    expect(s.byId.get("a.one")!.current).toEqual({ name: "One", value: 2, unknownThing: null });
    expect(s.byId.get("a.one")!.history).toHaveLength(1);
    expect(s.latest).toEqual({ recordId: "baseline", announcedOn: "2026-09-22" });
  });

  it("applies a modification, keeps the earlier definition and does not mutate its input", () => {
    const before = JSON.stringify(baseline);
    const s = resolveVersioned(baseline, [file(rec({ id: "r1", ops: [mod("a.one", { value: 1 }, { value: 2 })] }))], catalog);
    const e = s.byId.get("a.one")!;
    expect(e.current.value).toBe(1);
    expect(e.history.map((h) => h.snapshot?.value)).toEqual([2, 1]);
    expect(e.history[1]!.diffs).toEqual([{ prop: "value", from: 2, to: 1 }]);
    expect(JSON.stringify(baseline)).toBe(before);
  });

  it("is order-independent and reproducible", () => {
    const r1 = rec({ id: "r1", announcedOn: "2026-10-15", ops: [mod("a.one", { value: 1 }, { value: 2 })] });
    const r2 = rec({ id: "r2", announcedOn: "2026-10-26", ops: [mod("a.one", { value: 3 }, { value: 1 })] });
    const a = resolveVersioned(baseline, [file(r2), file(r1)], catalog);
    const b = resolveVersioned(baseline, [file(r1, r2)], catalog);
    expect(a.byId.get("a.one")!.current.value).toBe(3);
    expect(JSON.parse(JSON.stringify(a))).toEqual(JSON.parse(JSON.stringify(b)));
    expect(JSON.stringify(resolveVersioned(baseline, [file(r1, r2)], catalog).entities)).toBe(JSON.stringify(b.entities));
  });

  it("removal makes an ability non-current but keeps its history; restore brings it back", () => {
    const removed = rec({ id: "r1", ops: [{ entity: "a.two", type: "removed", summary: "Removed in a synthetic update." }] });
    const restored = rec({ id: "r2", announcedOn: "2026-10-26", ops: [{ entity: "a.two", type: "restored", set: { value: 6 }, summary: "Restored in a synthetic update." }] });
    const s1 = resolveVersioned(baseline, [file(removed)], catalog).byId.get("a.two")!;
    expect(s1.active).toBe(false);
    expect(s1.history.map((h) => h.type)).toEqual(["baseline", "removed"]);
    expect(s1.history[0]!.snapshot).toEqual({ name: "Two", value: 5 });
    const s2 = resolveVersioned(baseline, [file(removed, restored)], catalog).byId.get("a.two")!;
    expect(s2.active).toBe(true);
    expect(s2.current.value).toBe(6);
    expect(s2.history.map((h) => h.type)).toEqual(["baseline", "removed", "restored"]);
  });

  it("replacement = remove + add: obsolete definition leaves the current set, new one joins it", () => {
    const s = resolveVersioned(baseline, [file(rec({ id: "r1", ops: [
      { entity: "a.two", type: "removed", summary: "Replaced by a new ability." },
      { entity: "a.three", type: "added", kind: "ability", set: { name: "Three", value: 9 }, summary: "Introduced as a replacement." },
    ] }))], catalog);
    expect(s.entities.filter((e) => e.active).map((e) => e.id)).toEqual(["a.one", "a.three"]);
    expect(s.byId.get("a.two")!.history).toHaveLength(2);
  });

  it("handles renames as a recorded change", () => {
    const s = resolveVersioned(baseline, [file(rec({ id: "r1", ops: [{ entity: "a.one", type: "renamed", set: { name: "Uno" }, previous: { name: "One" }, summary: "Renamed in a synthetic update." }] }))], catalog);
    expect(s.byId.get("a.one")!.current.name).toBe("Uno");
    expect(s.byId.get("a.one")!.history[0]!.snapshot!.name).toBe("One");
  });

  it("never lets weaker evidence replace confirmed values; it is listed as pending", () => {
    for (const evidence of ["corroborated", "unverified"] as const) {
      const s = resolveVersioned(baseline, [file(rec({ id: "r1", evidence, ops: [mod("a.one", { value: 99 })] }))], catalog);
      expect(s.byId.get("a.one")!.current.value).toBe(2);
      expect(s.byId.get("a.one")!.pending).toHaveLength(1);
      expect(s.byId.get("a.one")!.pending[0]!.applied).toBe(false);
      expect(s.latest.recordId).toBe("baseline");
    }
  });

  it("a pending addition is not an established or active entity", () => {
    const s = resolveVersioned(baseline, [file(rec({ id: "r1", evidence: "unverified", ops: [{ entity: "a.new", type: "added", kind: "ability", set: { name: "New" }, summary: "Unverified rumour about a new ability." }] }))], catalog);
    const e = s.byId.get("a.new")!;
    expect(e.active).toBe(false);
    expect(e.history).toHaveLength(0);
    expect(e.pending).toHaveLength(1);
  });

  it("an unknown (null) baseline value cannot conflict with a later statement", () => {
    const s = resolveVersioned(baseline, [file(rec({ id: "r1", ops: [{ entity: "a.one", type: "modified", set: { unknownThing: 3 }, previous: { unknownThing: 8 }, summary: "Value became known." }] }))], catalog);
    expect(s.byId.get("a.one")!.current.unknownThing).toBe(3);
  });

  describe("evidence precedence is decided per property", () => {
    const base2: Baseline = {
      ...baseline,
      entities: [{ id: "a.x", kind: "ability", evidence: "official", propEvidence: { note: "corroborated" }, props: { name: "X", value: 4, note: "n", cooldown: null }, sources: ["base"] }],
    };
    const run = (r: ChangeRecord) => resolveVersioned(base2, [file(r)], catalog).byId.get("a.x")!;
    const doc = (evidence: ChangeRecord["evidence"], set: Record<string, string | number>) =>
      rec({ id: "r1", evidence, ops: [{ entity: "a.x", type: "documented", set, summary: "Detail reported by a community site." }] });

    it("community evidence fills an unknown property but never overwrites an official one", () => {
      const e = run(doc("corroborated", { cooldown: "3 min", value: 99 }));
      expect(e.current.cooldown).toBe("3 min");
      expect(e.propEvidence.cooldown).toBe("corroborated");
      expect(e.current.value).toBe(4);
      expect(e.propEvidence.value).toBe("official");
      expect(e.pending).toHaveLength(1);
      expect(e.pending[0]!.diffs).toEqual([{ prop: "value", from: undefined, to: 99 }]);
      expect(e.history.at(-1)!.diffs.map((d) => d.prop)).toEqual(["cooldown"]);
    });
    it("community evidence may refine a community-backed property, official evidence may replace it", () => {
      expect(run(doc("corroborated", { note: "m" })).current.note).toBe("m");
      const e = run(rec({ id: "r2", ops: [mod("a.x", { note: "official note" })] }));
      expect(e.current.note).toBe("official note");
      expect(e.propEvidence.note).toBe("official");
    });
    it("unverified evidence never applies, even to an unknown property", () => {
      const e = run(doc("unverified", { cooldown: "9 min" }));
      expect(e.current.cooldown).toBeNull();
      expect(e.pending).toHaveLength(1);
    });
    it("community evidence cannot add, remove or restore", () => {
      const r = rec({ id: "r3", evidence: "corroborated", ops: [{ entity: "a.x", type: "removed", summary: "Rumoured removal." }, { entity: "a.y", type: "added", kind: "ability", set: { name: "Y" }, summary: "Rumoured addition." }] });
      const s = resolveVersioned(base2, [file(r)], catalog);
      expect(s.byId.get("a.x")!.active).toBe(true);
      expect(s.byId.get("a.x")!.pending).toHaveLength(1);
      expect(s.byId.get("a.y")!.active).toBe(false);
    });
  });

  describe("fails explicitly instead of guessing", () => {
    const code = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof VersionedDataError ? e.code : "other"; } return "none"; };
    it.each([
      ["conflicting previous value", [rec({ id: "r1", ops: [mod("a.one", { value: 1 }, { value: 7 })] })], "conflict"],
      ["unknown entity", [rec({ id: "r1", ops: [mod("a.zzz", { value: 1 })] })], "unknown-entity"],
      ["double removal", [rec({ id: "r1", ops: [{ entity: "a.one", type: "removed", summary: "Removed once." }] }), rec({ id: "r2", announcedOn: "2026-10-16", ops: [{ entity: "a.one", type: "removed", summary: "Removed twice." }] })], "already-removed"],
      ["modifying a removed ability", [rec({ id: "r1", ops: [{ entity: "a.one", type: "removed", summary: "Removed once." }] }), rec({ id: "r2", announcedOn: "2026-10-16", ops: [mod("a.one", { value: 1 })] })], "already-removed"],
      ["restoring an active ability", [rec({ id: "r1", ops: [{ entity: "a.one", type: "restored", set: {}, summary: "Restore without removal." }] })], "not-removed"],
      ["adding an existing id", [rec({ id: "r1", ops: [{ entity: "a.one", type: "added", kind: "ability", set: { name: "X" }, summary: "Added a duplicate." }] })], "already-exists"],
      ["unknown source", [rec({ id: "r1", sources: ["nope"], ops: [mod("a.one", { value: 1 })] })], "unknown-source"],
      ["record before the baseline", [rec({ id: "r1", announcedOn: "2026-09-01", ops: [mod("a.one", { value: 1 })] })], "bad-order"],
      ["duplicate record id", [rec({ id: "r1", ops: [mod("a.one", { value: 1 })] }), rec({ id: "r1", announcedOn: "2026-10-16", ops: [mod("a.one", { value: 3 })] })], "duplicate-record"],
      ["empty record", [rec({ id: "r1", ops: [] })], "empty-record"],
    ])("%s", (_n, records, expected) => {
      expect(code(() => resolveVersioned(baseline, [file(...(records as ChangeRecord[]))], catalog))).toBe(expected);
    });
  });
});

describe("versioned schemas", () => {
  it("accept the synthetic fixtures", () => {
    expect(SourceCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(BaselineSchema.safeParse(baseline).success).toBe(true);
    expect(ChangeFileSchema.safeParse(file(rec({ id: "r1", ops: [mod("a.one", { value: 1 })] }))).success).toBe(true);
  });
  it("reject a build on a record that is not client-verified, and bad dates", () => {
    expect(ChangeFileSchema.safeParse(file(rec({ id: "r1", build: "1.60.1.70634", ops: [mod("a.one", { value: 1 })] }))).success).toBe(false);
    expect(ChangeFileSchema.safeParse(file(rec({ id: "r1", announcedOn: "2026-13-40", ops: [mod("a.one", { value: 1 })] }))).success).toBe(false);
  });
});
