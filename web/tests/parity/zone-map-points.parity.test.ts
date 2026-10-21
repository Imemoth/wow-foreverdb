import { afterAll, describe, expect, it } from "vitest";
import regression from "../fixtures/zone-semantics.projection.json";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import { PostgresAdapter } from "@/lib/data/postgres-adapter";
import { LOCATED_LOOT_KINDS, type PublicDataAdapter } from "@/lib/data/types";

/**
 * The zone-wide map read: fixture reference implementation (lib/data/zone-map-points.ts) vs the real web_api.zone_map_points
 * (migration 0002) on the same regression dataset published through the real worker. Skipped unless PARITY_DATABASE_URL is set
 * (CI: publisher-and-pipeline job; the database must have 0002 applied).
 */
const url = process.env.PARITY_DATABASE_URL;
const fixture: PublicDataAdapter = new FixtureAdapter(regression as unknown as ConstructorParameters<typeof FixtureAdapter>[0]);
const pg: PublicDataAdapter | null = url ? new PostgresAdapter(url) : null;
afterAll(async () => { await (pg as unknown as { pool?: { end(): Promise<void> } } | null)?.pool?.end().catch(() => undefined); });
if (!url && process.env.CI) throw new Error("PARITY_DATABASE_URL is required in CI");

describe.skipIf(!url)("zone map points: fixture <-> PostgreSQL parity", () => {
  it("serves the expected dataset (guards against comparing two empty answers)", async () => {
    const r = await pg!.zoneMapPoints(1420, null, 100);
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    expect(r.points.every((p) => p.observations >= 2)).toBe(true);
  });
  it.each([1420, 1421, 999])("zone %i: identical rows, order and totals", async (id) => {
    expect(await pg!.zoneMapPoints(id, null, 3000)).toEqual(await fixture.zoneMapPoints(id, null, 3000));
  });
  it.each(LOCATED_LOOT_KINDS.map((k) => [k]))("kind filter %s", async (k) => {
    expect(await pg!.zoneMapPoints(1420, k, 3000)).toEqual(await fixture.zoneMapPoints(1420, k, 3000));
  });
  it("limit and truncation flag", async () => {
    expect(await pg!.zoneMapPoints(1420, null, 1)).toEqual(await fixture.zoneMapPoints(1420, null, 1));
  });
  it("both reject the same invalid parameters", async () => {
    for (const args of [[0, null, 5], [1420, null, 0], [1420, null, 3001], [1420, "disenchant", 5]] as const) {
      await expect(pg!.zoneMapPoints(...(args as [number, null, number]))).rejects.toThrow();
      await expect(fixture.zoneMapPoints(...(args as [number, null, number]))).rejects.toThrow();
    }
  });
});

describe.skipIf(!url)("source map points: fixture <-> PostgreSQL parity (web_api.source_map_points, migration 0005)", () => {
  const q = (o: Partial<Parameters<PublicDataAdapter["sourceMapPoints"]>[0]> = {}) =>
    ({ sourceType: "creature", sourceId: 9001, mapId: null, lootKind: null, sourceLevel: null, limit: 3000, ...o }) as Parameters<PublicDataAdapter["sourceMapPoints"]>[0];
  it("serves the expected dataset (guards against comparing two empty answers)", async () => {
    const r = await pg!.sourceMapPoints(q());
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    expect(new Set(r.points.map((p) => p.mapId))).toEqual(new Set([1420, 1421]));
  });
  it.each([null, 1420, 1421, 999])("zone filter %s: identical rows, order and totals", async (mapId) => {
    expect(await pg!.sourceMapPoints(q({ mapId }))).toEqual(await fixture.sourceMapPoints(q({ mapId })));
  });
  it.each([["creature", 9002], ["gameobject", 9201], ["fishing", 9301], ["creature", 1]] as const)("%s %i", async (sourceType, sourceId) => {
    expect(await pg!.sourceMapPoints(q({ sourceType, sourceId }))).toEqual(await fixture.sourceMapPoints(q({ sourceType, sourceId })));
  });
  it.each(LOCATED_LOOT_KINDS.map((k) => [k]))("kind filter %s", async (k) => {
    expect(await pg!.sourceMapPoints(q({ lootKind: k }))).toEqual(await fixture.sourceMapPoints(q({ lootKind: k })));
  });
  it("level filter and truncation flag", async () => {
    expect(await pg!.sourceMapPoints(q({ sourceLevel: 10 }))).toEqual(await fixture.sourceMapPoints(q({ sourceLevel: 10 })));
    expect(await pg!.sourceMapPoints(q({ limit: 1 }))).toEqual(await fixture.sourceMapPoints(q({ limit: 1 })));
  });
  it("the zone overview and the source read return the same cells for the same source and zone", async () => {
    const zoneRows = (await pg!.zoneMapPoints(1420, null, 3000)).points.filter((p) => p.sourceType === "creature" && p.sourceId === 9001);
    const srcRows = (await pg!.sourceMapPoints(q({ mapId: 1420 }))).points.map(({ mapId: _m, ...rest }) => rest);
    expect(srcRows).toEqual(zoneRows);
  });
  it("both reject the same invalid parameters", async () => {
    for (const bad of [{ sourceType: "item" }, { limit: 0 }, { limit: 3001 }, { mapId: 0 }, { mapId: 1_000_000 }, { sourceLevel: 256 }, { lootKind: "disenchant" }] as const) {
      await expect(pg!.sourceMapPoints(q(bad as never))).rejects.toThrow();
      await expect(fixture.sourceMapPoints(q(bad as never))).rejects.toThrow();
    }
  });
});
