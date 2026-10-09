import { describe, expect, it } from "vitest";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import { InvalidQueryError, type SearchQuery } from "@/lib/data/types";
import { fmtRate } from "@/lib/format";
import { entityPath, searchPath, sourcePath } from "@/lib/routes";

const db = new FixtureAdapter();
const q = (o: Partial<SearchQuery>): SearchQuery => ({ q: "", category: null, zone: null, kind: null, sort: "relevance", page: 1, pageSize: 25, ...o });

describe("fixture adapter (mirrors web_api semantics)", () => {
  it("labels itself as synthetic sample data", async () => {
    expect(db.mode).toBe("synthetic-sample");
    expect((await db.meta()).mode).toBe("synthetic-sample");
  });
  it("finds by name with exact/prefix relevance, and by exact game ID", async () => {
    const r = await db.search(q({ q: "copper" }));
    expect(r.rows.map((x) => x.name)).toEqual(["Copper Ore", "Copper Vein"]);
    const byId = await db.search(q({ q: "2770" }));
    expect(byId.rows[0]).toMatchObject({ entityKind: "item", itemId: 2770 });
  });
  it("filters by category, zone and acquisition type", async () => {
    const mining = await db.search(q({ kind: "mining" }));
    expect(mining.rows.every((x) => x.lootKinds.includes("mining"))).toBe(true);
    const zone = await db.search(q({ zone: 1411, category: "creature" }));
    expect(zone.rows.length).toBeGreaterThan(0);
    expect(zone.rows.every((x) => x.displayKind === "creature" && x.mapIds.includes(1411))).toBe(true);
    await expect(db.search(q({}))).rejects.toBeInstanceOf(InvalidQueryError);
  });
  it("paginates stably", async () => {
    const all = await db.search(q({ kind: "mob", pageSize: 50 }));
    const p1 = await db.search(q({ kind: "mob", pageSize: 5, page: 1 }));
    const p2 = await db.search(q({ kind: "mob", pageSize: 5, page: 2 }));
    expect([...p1.rows, ...p2.rows]).toEqual(all.rows.slice(0, 10));
    expect(p1.total).toBe(all.total);
  });
  it("keeps creature levels separate and hides insufficient rates", async () => {
    const s = await db.source("creature", 1554);
    expect(s!.variants.map((v) => v.level)).toEqual([6, 7]);
    const weak = s!.variants.flatMap((v) => v.drops).filter((d) => d.confidence === "insufficient");
    expect(weak.length).toBeGreaterThan(0);
    expect(weak.every((d) => d.rate === null && fmtRate(d.rate, d.confidence) === "—")).toBe(true);
  });
  it("contains no hostile names or private identifiers", async () => {
    const all = JSON.stringify(await db.search(q({ kind: "mob", pageSize: 50 }))) + JSON.stringify(await db.zones());
    expect(all).not.toMatch(/<img|installation|CANARY|\u0007/);
  });
  it("serves disenchant sources and fishing pools", async () => {
    expect((await db.source("item", 6585))!.variants[0]!.buckets[0]!.lootKind).toBe("disenchant");
    expect((await db.source("gameobject", -184513))!.variants[0]!.displayKind).toBe("fishing_pool");
  });
});

describe("formatting and routes", () => {
  it("never shows more precision than the sample supports", () => {
    expect(fmtRate(0.4234, "low")).toBe("~42%");
    expect(fmtRate(0.4234, "medium")).toBe("42.3%");
    expect(fmtRate(0.0004, "high")).toBe("<0.1%");
    expect(fmtRate(null, "insufficient")).toBe("—");
  });
  it("builds collision-safe canonical paths", () => {
    expect(sourcePath("creature", 1554, 7)).toBe("/creature/1554#level-7");
    expect(sourcePath("gameobject", -184513)).toBe("/object/-184513");
    expect(sourcePath("fishing", 1420)).toBe("/fishing/1420");
    expect(entityPath({ entityKind: "item", itemId: 2770, sourceType: null, sourceId: null, sourceLevel: null })).toBe("/item/2770");
    expect(searchPath({ q: "a b", sort: "relevance", page: 1, zone: 1420 })).toBe("/database?q=a+b&zone=1420");
  });
});
