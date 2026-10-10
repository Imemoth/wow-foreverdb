import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import regression from "../fixtures/zone-semantics.projection.json";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import type { SearchQuery } from "@/lib/data/types";

/**
 * P2 regression on the deterministic fixture (database/tests/fixtures/zone_semantics_export.json):
 *   creature 9001 observed in zones 1420 (12 obs) and 1421 (8 obs); item 9101 has GLOBAL drops
 *   40 (9001) + 10 (9002, zone 1420 only) = 50; no zone-specific item drop count exists.
 */
const adapter = new FixtureAdapter(regression as unknown as ConstructorParameters<typeof FixtureAdapter>[0]);
const sq = (o: Partial<SearchQuery>): SearchQuery => ({ q: "", category: null, zone: null, kind: null, sort: "relevance", page: 1, pageSize: 25, ...o });
const zq = (mapId: number, o: Record<string, unknown> = {}) => ({ mapId, displayKind: null, lootKind: null, q: "", page: 1, pageSize: 50, ...o }) as Parameters<FixtureAdapter["zoneEntities"]>[0];

describe("zone directory semantics (adapter)", () => {
  it("the item appears in both relevant zones", async () => {
    for (const zone of [1420, 1421]) {
      const r = await adapter.zoneEntities(zq(zone, { displayKind: "item" }));
      expect(r.rows.map((x) => x.itemId)).toContain(9101);
    }
    expect((await adapter.search(sq({ q: "walker trinket" }))).rows[0]).toMatchObject({ itemId: 9101, mapIds: [1420, 1421] });
  });

  it("no zone row claims the global drop count; item rows are 'not measured' + inferred", async () => {
    for (const zone of [1420, 1421]) {
      const r = await adapter.zoneEntities(zq(zone));
      for (const row of r.rows.filter((x) => x.entityKind === "item")) {
        expect(row.observations).toBeNull();
        expect(row.association).toBe("inferred");
        expect(row.associatedSourceCount).toBeGreaterThan(0);
      }
      const item = r.rows.find((x) => x.itemId === 9101)!;
      expect(JSON.stringify(item)).not.toMatch(/"observations":50\b/);
    }
  });

  it("source rows keep measured zone observations and are listed before items; ordering is deterministic", async () => {
    const r = await adapter.zoneEntities(zq(1420));
    expect(r.rows.map((x) => `${x.entityKind}:${x.itemId ?? x.sourceId}:${x.observations}`)).toEqual([
      "source:9001:12", "source:9301:6", "source:9002:5", "source:1420:4",
      "item:9101:null", // 2 in-zone sources
      "item:9103:null", "item:9104:null", "item:9102:null", // 1 source each, then name order
    ]);
    expect(r.total).toBe(8);
    expect((await adapter.zoneEntities(zq(1421))).rows.map((x) => `${x.entityKind}:${x.itemId ?? x.sourceId}:${x.observations}`))
      .toEqual(["source:9001:8", "item:9102:null", "item:9101:null"]); // 1 source each: name order (Scrap < Trinket)
  });

  it("item detail lists both zones as inferred, with no numeric zone count", async () => {
    const d = (await adapter.item(9101))!;
    expect(d.item.totalDrops).toBe(50); // global, labelled as such by the item page
    expect(d.zones).toEqual([
      { mapId: 1420, zoneName: "Tirisfal Glades", observations: null, association: "inferred", sourceCount: 2 },
      { mapId: 1421, zoneName: "Silverpine Forest", observations: null, association: "inferred", sourceCount: 1 },
    ]);
  });

  it("source detail keeps genuine per-zone observations for BOTH zones", async () => {
    const d = (await adapter.source("creature", 9001))!;
    expect(d.zones).toEqual([
      { mapId: 1420, zoneName: "Tirisfal Glades", observations: 12, association: "observed" },
      { mapId: 1421, zoneName: "Silverpine Forest", observations: 8, association: "observed" },
    ]);
  });

  it("search keeps GLOBAL semantics: zone filter selects membership, observations stay global and sort by that", async () => {
    const r = await adapter.search(sq({ zone: 1420, sort: "observations" }));
    const items = r.rows.filter((x) => x.entityKind === "item");
    // Global drop totals: 9103=55, 9101=50, 9102=25, 9104=20 - NOT per-zone numbers.
    expect(items.map((x) => [x.itemId, x.observations])).toEqual([[9103, 55], [9101, 50], [9102, 25], [9104, 20]]);
    const z1421 = await adapter.search(sq({ zone: 1421, kind: "mob", sort: "observations" }));
    expect(z1421.rows.find((x) => x.itemId === 9101)).toMatchObject({ observations: 50 }); // same global value in both zones
  });

  it("existing source-level search, creature, gathering and fishing behaviour is intact", async () => {
    expect((await adapter.search(sq({ q: "fixture zone walker" }))).rows[0]).toMatchObject({ entityKind: "source", sourceType: "creature", sourceId: 9001, observations: 100, mapIds: [1420, 1421] });
    expect((await adapter.search(sq({ kind: "mining" }))).rows.map((x) => x.name)).toEqual(expect.arrayContaining(["Fixture Copper Vein", "Fixture Copper Nugget"]));
    expect((await adapter.search(sq({ kind: "fishing" }))).rows.map((x) => x.name)).toEqual(expect.arrayContaining(["Fishing - Tirisfal Glades"]));
    expect(await adapter.zone(1420)).toMatchObject({ observations: 27, sourceCount: 4, itemCount: 4 });
    expect((await adapter.zones()).map((z) => z.zoneName)).toEqual(["Silverpine Forest", "Tirisfal Glades"]);
  });
});

describe("zone directory semantics (API route + website labels)", () => {
  beforeEach(() => { vi.resetModules(); });

  it("GET /api/v1/zone/:id returns null/inferred item rows and no zone-specific item count", async () => {
    vi.doMock("@/lib/data", () => ({ data: () => adapter }));
    const { GET } = await import("@/app/api/v1/zone/[id]/route");
    const res = await GET(new Request("http://localhost:3000/api/v1/zone/1420"), { params: Promise.resolve({ id: "1420" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rows: { entityKind: string; itemId: number | null; observations: number | null; association: string }[] } };
    const items = body.data.rows.filter((r) => r.entityKind === "item");
    expect(items.length).toBe(4);
    expect(items.every((r) => r.observations === null && r.association === "inferred")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"observations":50\b/);
    vi.doUnmock("@/lib/data");
  });

  it("the table never prints a number for an item and says 'Not measured' + 'inferred via N sources'", async () => {
    const { ResultsTable } = await import("@/components/ResultsTable");
    const zones = await adapter.zones();
    const { rows } = await adapter.zoneEntities(zq(1420, { displayKind: "item" }));
    const html = renderToStaticMarkup(ResultsTable({ rows, zones, caption: "t", observationsLabel: "Observed in this zone" }));
    expect(html).toContain("Observed in this zone");
    expect(html).not.toContain("In-zone obs.");
    expect(html.match(/Not measured/g)).toHaveLength(4);
    expect(html).toContain("inferred via 2 sources");
    expect(html).toContain("inferred via 1 source<");
    const cells = [...html.matchAll(/<td class="num[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, " ").trim());
    for (const c of cells) expect(c).not.toMatch(/\b(50|40|25|10)\b(?!.*source)/);
  });

  it("source rows in the same table show their measured number; search tables are labelled as all-zone totals", async () => {
    const { ResultsTable } = await import("@/components/ResultsTable");
    const zones = await adapter.zones();
    const z = await adapter.zoneEntities(zq(1420, { displayKind: "creature" }));
    expect(renderToStaticMarkup(ResultsTable({ rows: z.rows, zones, caption: "t" }))).toMatch(/>12</);
    const s = await adapter.search(sq({ zone: 1420 }));
    expect(renderToStaticMarkup(ResultsTable({ rows: s.rows, zones, caption: "t" }))).toContain("Observations (all zones)");
  });
});

describe("shared sample dataset (existing synthetic data)", () => {
  it("never exposes a numeric zone count for any item in any zone", async () => {
    const shared = new FixtureAdapter();
    for (const z of await shared.zones()) {
      const r = await shared.zoneEntities({ mapId: z.mapId, displayKind: null, lootKind: null, q: "", page: 1, pageSize: 100 });
      for (const row of r.rows.filter((x) => x.entityKind === "item")) expect(row.observations).toBeNull();
      for (const row of r.rows.filter((x) => x.entityKind === "source")) expect(row.observations).toBeGreaterThan(0);
    }
  });
});
