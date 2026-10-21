import { describe, expect, it } from "vitest";
import { GET as zoneGet } from "@/app/api/v1/zones/[id]/map-points/route";
import { GET as sourceGet } from "@/app/api/v1/sources/[type]/[id]/map-points/route";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import { LOCATED_LOOT_KINDS } from "@/lib/data/types";
import { parseSourceMapPointQuery, parseZoneMapPointQuery } from "@/lib/validation";

interface Cell { sourceType: string; sourceId: number; sourceLevel: number; name: string; lootKind: string; subzone: string; x: number; y: number; observations: number; mapId?: number }
interface Reply { status: number; headers: Headers; body: { publicationId: number | null; data: { uiMapId: number | null; points: Cell[]; totalCells: number; truncated: boolean } } }

const call = async (handler: (req: Request, ctx: { params: Promise<never> }) => Promise<Response>, url: string, params: Record<string, string>): Promise<Reply> => {
  const res = await handler(new Request(`http://localhost${url}`), { params: Promise.resolve(params as never) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Reply["body"] };
};
const zone = (id: string, qs = "") => call(zoneGet as never, `/api/v1/zones/${id}/map-points${qs}`, { id });
const source = (type: string, id: string, qs = "") => call(sourceGet as never, `/api/v1/sources/${type}/${id}/map-points${qs}`, { type, id });

const FORBIDDEN = /installation|owner|contributor|account|user_?id|email|device|guild|member|suppress|private/i;

describe("GET /api/v1/zones/{id}/map-points", () => {
  it("returns published cells of the zone with the contract fields and cache headers", async () => {
    const r = await zone("1420");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/s-maxage/);
    expect(r.body.data.uiMapId).toBe(1420);
    expect(r.body.data.points.length).toBeGreaterThan(0);
    expect(typeof r.body.publicationId === "number" || r.body.publicationId === null).toBe(true);
    for (const p of r.body.data.points) {
      expect(Object.keys(p).sort()).toEqual(["lootKind", "name", "observations", "sourceId", "sourceLevel", "sourceType", "subzone", "x", "y"]);
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
      expect(p.observations).toBeGreaterThanOrEqual(2);
    }
  });
  it("exposes no contributor, installation, owner or suppressed-cell data anywhere in the response", async () => {
    const text = JSON.stringify((await zone("1420")).body);
    expect(text).not.toMatch(FORBIDDEN);
  });
  it("filters by loot kind and keeps total/truncated honest", async () => {
    const all = await zone("1420");
    const mining = await zone("1420", "?kind=mining");
    expect(mining.status).toBe(200);
    expect(mining.body.data.points.every((p: Cell) => p.lootKind === "mining")).toBe(true);
    expect(mining.body.data.totalCells).toBeLessThanOrEqual(all.body.data.totalCells);
    const one = await zone("1420", "?limit=1");
    expect(one.body.data.points).toHaveLength(1);
    expect(one.body.data.truncated).toBe(all.body.data.totalCells > 1);
    expect(one.body.data.totalCells).toBe(all.body.data.totalCells);
    expect(one.body.data.points[0]).toEqual(all.body.data.points[0]);
  });
  it("an empty/unobserved zone is a valid, empty answer", async () => {
    const r = await zone("1412");
    expect([200]).toContain(r.status);
    expect(Array.isArray(r.body.data.points)).toBe(true);
    const none = await zone("999999");
    expect(none.status).toBe(200);
    expect(none.body.data).toMatchObject({ points: [], totalCells: 0, truncated: false });
  });
  it.each([
    ["0"], ["01420"], ["-1"], ["abc"], ["1000000"], ["1420.5"], ["1420%20"], ["9999999999999"],
  ])("rejects the invalid UiMapID %s", async (id) => {
    expect((await zone(id)).status).toBe(400);
  });
  it.each([
    ["?kind=disenchant"], ["?kind=nope"], ["?kind=mining&kind=mob"], ["?limit=0"], ["?limit=3001"], ["?limit=abc"], ["?foo=bar"], ["?kind=mob%27%3B--"],
  ])("rejects the invalid query %s", async (qs) => {
    expect((await zone("1420", qs)).status).toBe(400);
  });
  it("treats an empty parameter value as absent (repo-wide convention)", async () => {
    expect(JSON.stringify((await zone("1420", "?kind=")).body)).toBe(JSON.stringify((await zone("1420")).body));
  });
  it("is stable: the same request gives the same bytes", async () => {
    expect(JSON.stringify((await zone("1420")).body)).toBe(JSON.stringify((await zone("1420")).body));
  });
});

describe("GET /api/v1/sources/{type}/{id}/map-points", () => {
  it("serves a source's cells for one zone, consistent with the zone overview", async () => {
    const z = await zone("1420");
    const ids = new Set<string>(z.body.data.points.map((p: Cell) => `${p.sourceType}:${p.sourceId}`));
    expect(ids.size).toBeGreaterThan(0);
    for (const key of ids) {
      const [t, i] = key.split(":") as [string, string];
      const s = await source(t, i, "?zone=1420");
      expect(s.status).toBe(200);
      const fromZone = z.body.data.points.filter((p: Cell) => p.sourceType === t && String(p.sourceId) === i);
      const stripped = s.body.data.points.map(({ mapId, ...rest }: Cell) => { expect(mapId).toBe(1420); return rest; });
      expect(stripped).toEqual(fromZone);
      expect(s.body.data.totalCells).toBe(fromZone.length);
    }
  });
  it("includes the UiMapID on each cell and honours zone, kind and level filters", async () => {
    const z = await zone("1420");
    const p0 = z.body.data.points[0]!;
    const s = await source(p0.sourceType, String(p0.sourceId), `?zone=1420&kind=${p0.lootKind}&level=${p0.sourceLevel}`);
    expect(s.status).toBe(200);
    expect(s.body.data.points.length).toBeGreaterThan(0);
    for (const p of s.body.data.points) {
      expect(p).toMatchObject({ mapId: 1420, lootKind: p0.lootKind, sourceLevel: p0.sourceLevel });
    }
    const other = await source(p0.sourceType, String(p0.sourceId), "?zone=999998");
    expect(other.status).toBe(200);
    expect(other.body.data.points).toEqual([]);
  });
  it("404 for an unpublished source; 400 for items, unknown types and malformed ids", async () => {
    expect((await source("creature", "424242424")).status).toBe(404);
    for (const [t, i] of [["item", "1"], ["guild", "1"], ["creature", "0"], ["creature", "01"], ["creature", "-5"], ["creature", "x"], ["gameobject", "1.5"]] as const) {
      expect((await source(t, i)).status).toBe(400);
    }
  });
  it.each([["?zone=0"], ["?zone=1000000"], ["?kind=disenchant"], ["?level=256"], ["?limit=3001"], ["?bogus=1"], ["?zone=1420&zone=1421"]])("rejects the invalid query %s", async (qs) => {
    const z = await zone("1420");
    const p0 = z.body.data.points[0]!;
    expect((await source(p0.sourceType, String(p0.sourceId), qs)).status).toBe(400);
  });
});

describe("validation helpers", () => {
  it("defaults and bounds", () => {
    expect(parseZoneMapPointQuery(new URLSearchParams())).toEqual({ lootKind: null, limit: 3000 });
    for (const k of LOCATED_LOOT_KINDS) expect(parseZoneMapPointQuery(new URLSearchParams({ kind: k })).lootKind).toBe(k);
    expect(parseSourceMapPointQuery("creature", 5, new URLSearchParams({ zone: "1420", level: "0" }))).toMatchObject({ mapId: 1420, sourceLevel: 0, lootKind: null, limit: 3000 });
  });
});

describe("fixture adapter source read mirrors the specification", () => {
  it("rejects invalid parameters like the SQL function", async () => {
    const db = new FixtureAdapter();
    const base = { sourceType: "creature", sourceId: 1, mapId: null, lootKind: null, sourceLevel: null, limit: 10 } as const;
    for (const bad of [{ sourceType: "item" }, { limit: 0 }, { limit: 3001 }, { mapId: 0 }, { sourceLevel: 256 }, { lootKind: "disenchant" }] as const) {
      await expect(db.sourceMapPoints({ ...base, ...bad } as never)).rejects.toThrow();
    }
  });
});
