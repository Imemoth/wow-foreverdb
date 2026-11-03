import { describe, expect, it } from "vitest";
import type { SourceDetail } from "@/lib/data/types";
import { filterByLevel, levelFromHash, levelLabel, levelOptions, parseLevelParam } from "@/lib/maps/creature-levels";
import { buildSourceZoneViews } from "@/lib/maps/source-zone-views";

const variant = (level: number, totalObservations: number) => ({ name: "Chakuyak", level, displayKind: "creature", indexable: false, totalObservations, lastObservedAt: null, buckets: [], drops: [] }) as never;
const loc = (mapId: number, level: number, x = 40, y = 50, observations = 3) => ({ level, lootKind: "mob" as const, mapId, subzone: "", x, y, observations });
const detail = (over: Partial<SourceDetail>): SourceDetail => ({ type: "creature", id: 268558, variants: [], zones: [], locations: [], ...over });
const art = (id: number) => (id === 1412 || id === 1420 ? { version: "v1", size: { width: 1002, height: 668 } } : null);
const opts = { artFor: art, nameFor: (id: number) => (id === 9999 ? "Catalog Name" : undefined), includeUnpublishedZones: true };

describe("level options come only from the observed data (never invented, never merged)", () => {
  it("lists exactly the observed levels with each level's own sample size", () => {
    const o = levelOptions(detail({ variants: [variant(6, 1), variant(5, 3)], locations: [loc(1412, 5), loc(1412, 5, 41, 50)] }));
    expect(o.map((x) => x.level)).toEqual([5, 6]);
    expect(o.map((x) => x.label)).toEqual(["Level 5", "Level 6"]);
    expect(o.map((x) => x.observations)).toEqual([3, 1]); // not 4: the samples are never summed
    expect(o.map((x) => x.cells)).toEqual([2, 0]);
  });
  it("places the unknown (historical) level last and labels it honestly", () => {
    const o = levelOptions(detail({ variants: [variant(0, 2), variant(3, 5)] }));
    expect(o.map((x) => x.level)).toEqual([3, 0]);
    expect(levelLabel(0)).toBe("Level ? (historical)");
  });
  it("a location level without a variant is still an observed level; a single level yields one option", () => {
    expect(levelOptions(detail({ variants: [variant(5, 1)], locations: [loc(1, 7)] })).map((x) => x.level)).toEqual([5, 7]);
    expect(levelOptions(detail({ variants: [variant(5, 1)] }))).toHaveLength(1);
  });
});

describe("level parameters", () => {
  const opts5 = levelOptions(detail({ variants: [variant(5, 1), variant(6, 1)] }));
  it("accepts only observed levels, from ?level= or #level-N, and silently ignores anything else", () => {
    expect(parseLevelParam("5", opts5)).toBe(5);
    expect(parseLevelParam(["6", "5"], opts5)).toBe(6);
    for (const bad of ["7", "05x", "-1", "", "5.5", "1000", "all", undefined, null, "5 "]) expect(parseLevelParam(bad as never, opts5), String(bad)).toBeNull();
    expect(levelFromHash("#level-6", opts5)).toBe(6);
    for (const bad of ["#level-9", "#level-", "#levels-5", "level-5", "#level-5/x", ""]) expect(levelFromHash(bad, opts5), bad).toBeNull();
  });
  it("filterByLevel keeps levels separate and null means every level", () => {
    const items = [{ level: 5, n: 1 }, { level: 6, n: 2 }, { level: 5, n: 3 }];
    expect(filterByLevel(items, 5).map((i) => i.n)).toEqual([1, 3]);
    expect(filterByLevel(items, 6).map((i) => i.n)).toEqual([2]);
    expect(filterByLevel(items, null)).toHaveLength(3);
    expect(filterByLevel(items, 9)).toEqual([]);
  });
});

describe("source zone views (multiple zones, no published locations)", () => {
  it("an observed zone with artwork but NO published cell is listed with empty points (real map, no invented marker)", () => {
    const v = buildSourceZoneViews(detail({ variants: [variant(5, 3), variant(6, 1)], zones: [{ mapId: 1412, zoneName: "Mulgore", association: "observed", observations: 4 }] as never, locations: [] }), opts);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ mapId: 1412, zoneName: "Mulgore", zoneObservations: 4, points: [], locations: [] });
    expect(v[0]!.art).not.toBeNull();
    expect(v[0]!.zoneHref).toBe("/zone/1412?source=creature:268558");
  });
  it("an observed zone WITHOUT artwork and without points is not a map zone; with points it is (grid view)", () => {
    const zones = [{ mapId: 1426, zoneName: "Dun Morogh", association: "observed", observations: 9 }, { mapId: 1412, zoneName: "Mulgore", association: "observed", observations: 4 }] as never;
    expect(buildSourceZoneViews(detail({ zones }), opts).map((z) => z.mapId)).toEqual([1412]);
    const withPts = buildSourceZoneViews(detail({ zones, locations: [loc(1426, 5)] }), opts);
    expect(withPts.map((z) => z.mapId).sort()).toEqual([1412, 1426]);
    expect(withPts.find((z) => z.mapId === 1426)!.art).toBeNull();
  });
  it("several zones keep their own points, are ordered by the zone observation count, and level data stays on each point", () => {
    const zones = [{ mapId: 1412, zoneName: "Mulgore", association: "observed", observations: 4 }, { mapId: 1420, zoneName: "Tirisfal Glades", association: "observed", observations: 50 }] as never;
    const v = buildSourceZoneViews(detail({ zones, variants: [variant(5, 30), variant(6, 24)], locations: [loc(1412, 5), loc(1420, 5), loc(1420, 6), loc(1420, 6, 60, 61)] }), opts);
    expect(v.map((z) => z.mapId)).toEqual([1420, 1412]);
    expect(v[0]!.points.map((p) => p.level)).toEqual([5, 6, 6]);
    expect(v[1]!.points.map((p) => p.level)).toEqual([5]);
    expect(v[0]!.points.every((p) => p.mapId === 1420)).toBe(true);
  });
  it("invalid coordinates never become markers, and the zone name falls back to the catalog name", () => {
    const v = buildSourceZoneViews(detail({ locations: [loc(9999, 5, 140, 50), loc(9999, 5, 40, 50)] }), { ...opts, artFor: () => ({ version: "v1", size: { width: 10, height: 10 } }) });
    expect(v[0]!.zoneName).toBe("Catalog Name");
    expect(v[0]!.points).toHaveLength(1);
  });
  it("without includeUnpublishedZones the behaviour is the previous one (zones with points only)", () => {
    const zones = [{ mapId: 1412, zoneName: "Mulgore", association: "observed", observations: 4 }] as never;
    expect(buildSourceZoneViews(detail({ zones }), { ...opts, includeUnpublishedZones: false })).toEqual([]);
  });
});
