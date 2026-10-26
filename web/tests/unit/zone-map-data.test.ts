import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sample from "@/lib/data/fixture/public-projection.sample.json";
import { FixtureAdapter } from "@/lib/data/fixture-adapter";
import { LOCATED_LOOT_KINDS, LOOT_KINDS, ZONE_MAP_POINT_LIMIT, type SourceDetail, type ZoneMapPointRow } from "@/lib/data/types";
import { MIN_CELL_OBSERVATIONS, aggregateZoneMapPoints, type PublishedLocation } from "@/lib/data/zone-map-points";
import snapshot from "@/lib/maps/atlas/atlas-index.snapshot.json";
import { createAtlasCatalogLoader } from "@/lib/maps/atlas/catalog-loader";
import { parseMapFocus, zoneMapHref } from "@/lib/maps/focus";
import { resolveObservedMap } from "@/lib/maps/identity";
import { pointsFromSource, pointsFromZoneRows, sourceZonesWithPoints } from "@/lib/maps/observation-adapters";
import { NO_FILTER, filterPoints } from "@/lib/maps/observations";
import { assetOriginForPage, isZoneMapRoute, zoneMapsEnabled } from "@/lib/maps/zone-maps-gate";
import { buildPageCsp } from "@/lib/security/headers";

const db = new FixtureAdapter();
const loc = (o: Partial<PublishedLocation> = {}): PublishedLocation => ({
  source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", map_id: 1420, subzone_name: "A", x: 10, y: 20, observations: 3, ...o,
});
const names = () => "Name";

describe("zone-wide map read: privacy and count invariants (executable spec of web_api.zone_map_points)", () => {
  it("never returns a cell below the publication floor, and a floor applies BEFORE summing", () => {
    expect(MIN_CELL_OBSERVATIONS).toBe(2);
    const r = aggregateZoneMapPoints([loc({ observations: 1 }), loc({ observations: 1, x: 10.4 }), loc({ x: 50, observations: 2 })], names, 1420, null, 100);
    // two sub-threshold cells that coincide after re-quantization must NOT combine into a visible cell
    expect(r.points.map((p) => [p.x, p.y, p.observations])).toEqual([[50, 20, 2]]);
    expect(r.totalCells).toBe(1);
  });
  it("re-quantizes to the 1% grid (no finer coordinate leaves) and sums cells that coincide", () => {
    const r = aggregateZoneMapPoints([loc({ x: 10.2, y: 20.1, observations: 2 }), loc({ x: 9.8, y: 19.9, observations: 3 })], names, 1420, null, 10);
    expect(r.points).toEqual([expect.objectContaining({ x: 10, y: 20, observations: 5 })]);
    for (const p of aggregateZoneMapPoints([loc({ x: 33.6, y: 44.4 })], names, 1420, null, 10).points) {
      expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
    }
  });
  it("never locates disenchant results or item-backed sources", () => {
    const r = aggregateZoneMapPoints([loc({ loot_kind: "disenchant" }), loc({ source_type: "item", loot_kind: "gameobject" }), loc({ x: 30 })], names, 1420, null, 10);
    expect(r.points).toHaveLength(1);
    expect(aggregateZoneMapPoints([loc()], names, 1420, "mob", 10).points).toHaveLength(1);
  });
  it("keeps creature levels separate (never merged into one identity)", () => {
    const r = aggregateZoneMapPoints([loc({ source_level: 5 }), loc({ source_level: 6 })], names, 1420, null, 10);
    expect(r.points.map((p) => p.sourceLevel).sort()).toEqual([5, 6]);
  });
  it("only the requested zone", () => {
    expect(aggregateZoneMapPoints([loc({ map_id: 1421 })], names, 1420, null, 10).points).toEqual([]);
  });
  it("is deterministic and bounded; truncation is reported honestly", () => {
    const rows = Array.from({ length: 40 }, (_, i) => loc({ source_id: i + 1, x: i, y: i, observations: 2 + (i % 5) }));
    const a = aggregateZoneMapPoints(rows, names, 1420, null, 10);
    const b = aggregateZoneMapPoints([...rows].reverse(), names, 1420, null, 10);
    expect(b).toEqual(a);
    expect(a.points).toHaveLength(10);
    expect(a.totalCells).toBe(40);
    expect(a.truncated).toBe(true);
    expect(a.points.every((p, i, arr) => i === 0 || arr[i - 1]!.observations >= p.observations)).toBe(true);
  });
  it("filtering cannot reveal a cell the unfiltered read withholds (no filter differencing)", () => {
    const rows: PublishedLocation[] = [
      loc({ x: 10, observations: 1 }), loc({ x: 11, observations: 4 }),
      loc({ x: 12, loot_kind: "skinning", observations: 1 }), loc({ x: 13, loot_kind: "skinning", observations: 2 }),
      loc({ x: 14, source_id: 2, loot_kind: "mining", source_type: "gameobject", observations: 1 }),
    ];
    const all = aggregateZoneMapPoints(rows, names, 1420, null, 100);
    const key = (p: ZoneMapPointRow) => `${p.sourceType}|${p.sourceId}|${p.sourceLevel}|${p.lootKind}|${p.x}|${p.y}`;
    const allKeys = new Set(all.points.map(key));
    for (const k of LOCATED_LOOT_KINDS) {
      for (const p of aggregateZoneMapPoints(rows, names, 1420, k, 100).points) expect(allKeys.has(key(p))).toBe(true);
    }
    // per-kind results partition the unfiltered result exactly (no extra, no missing)
    const union = LOCATED_LOOT_KINDS.flatMap((k) => aggregateZoneMapPoints(rows, names, 1420, k, 100).points.map(key)).sort();
    expect(union).toEqual([...allKeys].sort());
    expect(all.points.every((p) => p.observations >= 2)).toBe(true);
  });
  it("returned rows carry no contributor/installation/account field", () => {
    const [p] = aggregateZoneMapPoints([loc()], names, 1420, null, 10).points;
    expect(Object.keys(p!).sort()).toEqual(["lootKind", "name", "observations", "sourceId", "sourceLevel", "sourceType", "subzone", "x", "y"]);
  });
  it("count semantics: located-observation tile (zone total) and plotted cells are different numbers and are labelled as such", async () => {
    const z = await db.zone(1420);
    const r = await db.zoneMapPoints(1420, null, ZONE_MAP_POINT_LIMIT);
    const plotted = r.points.reduce((a, p) => a + p.observations, 0);
    expect(z!.observations).toBeGreaterThan(0);
    expect(plotted).toBeLessThanOrEqual(z!.observations);
    expect(r.totalCells).toBe(r.points.length);
  });
});

describe("fixture adapter zoneMapPoints mirrors the SQL contract", () => {
  it("serves only published cells of the zone with source names; every point is valid and located", async () => {
    const r = await db.zoneMapPoints(1420, null, ZONE_MAP_POINT_LIMIT);
    expect(r.points.length).toBeGreaterThan(50);
    expect(r.points.every((p) => p.observations >= 2 && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100 && p.name.length > 0)).toBe(true);
    expect(r.points.every((p) => p.lootKind !== "disenchant" && p.sourceType !== "item")).toBe(true);
    expect(new Set(r.points.map((p) => p.lootKind)).size).toBeGreaterThan(1);
    const only = await db.zoneMapPoints(1420, "mining", 3000);
    expect(only.points.every((p) => p.lootKind === "mining")).toBe(true);
  });
  it("is bounded and validates its parameters", async () => {
    expect((await db.zoneMapPoints(1420, null, 5)).points).toHaveLength(5);
    await expect(db.zoneMapPoints(0, null, 5)).rejects.toThrow();
    await expect(db.zoneMapPoints(1420, null, 3001)).rejects.toThrow();
    await expect(db.zoneMapPoints(1420, "disenchant", 5)).rejects.toThrow();
    expect((await db.zoneMapPoints(424242, null, 5)).points).toEqual([]);
  });
  it("source pages and the zone read agree: every zone cell of a source also appears in that source's published locations", async () => {
    const zone = await db.zoneMapPoints(1420, null, ZONE_MAP_POINT_LIMIT);
    const ids = [...new Set(zone.points.map((p) => `${p.sourceType}|${p.sourceId}`))].slice(0, 8);
    for (const k of ids) {
      const [t, i] = k.split("|");
      const src = (await db.source(t as "creature", Number(i)))!;
      const published = new Set(src.locations.filter((l) => l.mapId === 1420).map((l) => `${l.level}|${l.lootKind}|${l.x}|${l.y}`));
      for (const p of zone.points.filter((x) => x.sourceType === t && x.sourceId === Number(i))) expect(published.has(`${p.sourceLevel}|${p.lootKind}|${p.x}|${p.y}`)).toBe(true);
    }
  });
});

describe("identifier bridge: public-read map_id === atlas uiMapId", () => {
  const cat = createAtlasCatalogLoader({ base: null, snapshot });
  it("every fixture zone resolves to the same-named atlas zone (corroborating evidence)", async () => {
    const catalog = await cat();
    for (const z of sample.projection.zones) {
      const r = resolveObservedMap(catalog, z.map_id, z.zone_name);
      expect(r.kind).toBe("atlas-zone");
      expect(r.kind === "atlas-zone" && r.nameMatches).toBe(true);
    }
  });
  it("ids the atlas does not know, or knows as non-zone maps, are reported - never mapped to other art", async () => {
    const catalog = await cat();
    expect(resolveObservedMap(catalog, 999999).kind).toBe("not-in-atlas");
    expect(resolveObservedMap(catalog, 947).kind).toBe("atlas-other");
    expect(resolveObservedMap(catalog, 1459).kind).toBe("atlas-other"); // battleground map
    expect(resolveObservedMap(catalog, 1420, "Silverpine Forest")).toMatchObject({ kind: "atlas-zone", nameMatches: false });
    expect(resolveObservedMap(catalog, 1.5).kind).toBe("not-in-atlas");
  });
  it("does not use internalMapId or slugs: Zephras Isle 2521 vs 2665 share name and internal MapID but resolve separately", async () => {
    const catalog = await cat();
    const a = resolveObservedMap(catalog, 2521), b = resolveObservedMap(catalog, 2665);
    expect(a.kind === "atlas-zone" && a.map.uiMapId).toBe(2521);
    expect(b.kind === "atlas-zone" && b.map.uiMapId).toBe(2665);
    expect(resolveObservedMap(catalog, 2991).kind).toBe("not-in-atlas"); // 2991 is the internal MapID, not a uiMapID
  });
});

describe("observation adapters", () => {
  it("source points: only this zone, levels kept apart, names from their own level, no item/disenchant/invalid points", async () => {
    const d = (await db.source("creature", 1508))!;
    const pts = pointsFromSource(d, 1420);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.mapId === 1420 && p.sourceId === 1508 && p.sourceName === d.variants[0]!.name)).toBe(true);
    expect(new Set(pts.map((p) => p.id)).size).toBe(pts.length);
    const bad: SourceDetail = { ...d, locations: [
      ...d.locations, { level: 1, lootKind: "mob", mapId: 1420, subzone: "", x: 101, y: 5, observations: 4 },
      { level: 1, lootKind: "disenchant", mapId: 1420, subzone: "", x: 5, y: 5, observations: 4 },
      { level: 1, lootKind: "mob", mapId: 1420, subzone: "", x: 5, y: 5, observations: 0 },
    ] };
    expect(pointsFromSource(bad, 1420)).toHaveLength(pts.length);
    expect(pointsFromSource({ ...d, type: "item" }, 1420)).toEqual([]);
  });
  it("sourceZonesWithPoints lists only zones with at least one valid point", async () => {
    const d = (await db.source("creature", 1508))!;
    const z = sourceZonesWithPoints(d);
    expect(z.length).toBeGreaterThan(0);
    expect(z.every((x) => x.points.length > 0)).toBe(true);
  });
  it("zone points: valid rows become unique map points on the requested map", async () => {
    const r = await db.zoneMapPoints(1420, null, 3000);
    const pts = pointsFromZoneRows(r.points, 1420);
    expect(pts).toHaveLength(r.points.length);
    expect(new Set(pts.map((p) => p.id)).size).toBe(pts.length);
    expect(pointsFromZoneRows([{ ...r.points[0]!, sourceType: "item" }, { ...r.points[0]!, x: -1 }], 1420)).toEqual([]);
  });
  it("source focus filters to one source without merging its levels; levels can be narrowed", async () => {
    const r = pointsFromZoneRows((await db.zoneMapPoints(1420, null, 3000)).points, 1420);
    const first = r.find((p) => p.sourceType === "creature")!;
    const only = filterPoints(r, { ...NO_FILTER, source: { type: first.sourceType, id: first.sourceId, level: null } });
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((p) => p.sourceId === first.sourceId && p.sourceType === first.sourceType)).toBe(true);
    const lv = filterPoints(r, { ...NO_FILTER, source: { type: first.sourceType, id: first.sourceId, level: first.level } });
    expect(lv.every((p) => p.level === first.level)).toBe(true);
  });
});

describe("URL focus (zone page ?source= & ?kind=) is validated, never trusted", () => {
  const p = (s: string) => parseMapFocus(new URLSearchParams(s));
  it("accepts well-formed values", () => {
    expect(p("source=gameobject:1731&kind=mining")).toEqual({ kinds: new Set(["mining"]), source: { type: "gameobject", id: 1731, level: null } });
    expect(p("source=creature:1508:12").source).toEqual({ type: "creature", id: 1508, level: 12 });
    expect(p("source=gameobject:-5").source).toEqual({ type: "gameobject", id: -5, level: null });
  });
  it.each(["source=item:1", "source=creature:abc", "source=creature:1:1234", "source=../../etc", "source=creature:01", "source=creature:1;drop", "kind=disenchant", "kind=<script>", "kind=MINING"])("ignores %s", (q) => {
    const f = p(q);
    expect(f.kinds.size).toBe(0);
    expect(f.source).toBeNull();
  });
  it("builds the whole-zone link that keeps the source in focus", () => {
    expect(zoneMapHref(1420, { type: "gameobject", id: 1731, level: null })).toBe("/zone/1420?source=gameobject:1731");
    expect(zoneMapHref(1420, { type: "creature", id: 5, level: 3 })).toBe("/zone/1420?source=creature:5:3");
    expect(zoneMapHref(1420)).toBe("/zone/1420");
    // round trip
    expect(parseMapFocus(new URLSearchParams(zoneMapHref(1420, { type: "creature", id: 5, level: 3 }).split("?")[1])).source).toEqual({ type: "creature", id: 5, level: 3 });
  });
  it("only located loot kinds are accepted", () => {
    for (const k of LOOT_KINDS) expect(p(`kind=${k}`).kinds.size).toBe(k === "disenchant" ? 0 : 1);
  });
});

describe("feature gate and CSP scope", () => {
  it("off unless exactly AZERDEX_ZONE_MAPS=1", () => {
    expect(zoneMapsEnabled({})).toBe(false);
    expect(zoneMapsEnabled({ AZERDEX_ZONE_MAPS: "true" })).toBe(false);
    expect(zoneMapsEnabled({ AZERDEX_ZONE_MAPS: "0" })).toBe(false);
    expect(zoneMapsEnabled({ AZERDEX_ZONE_MAPS: "1" })).toBe(true);
  });
  it("only the zone and source-detail routes are map routes", () => {
    for (const ok of ["/zone/1420", "/creature/1508", "/object/1731", "/object/-5", "/fishing/12"]) expect(isZoneMapRoute(ok)).toBe(true);
    for (const no of ["/", "/zones", "/item/2770", "/database", "/account/devices", "/zone/1420/extra", "/zone/abc", "/api/zone/1", "/poc/maps/tirisfal", "/zone/"]) expect(isZoneMapRoute(no)).toBe(false);
  });
  it("assetOriginForPage: every HTML document gets the validated origin while the experience is on (soft navigation keeps the first document's CSP)", () => {
    const base = "https://azerdex-assets.pages.dev";
    const on = { AZERDEX_ZONE_MAPS: "1" };
    for (const p of ["/", "/zones", "/database", "/item/2770", "/about/data", "/download", "/zone/1420", "/object/1731", "/account/login", "/verify"]) {
      expect(assetOriginForPage(p, base, on), p).toBe("https://azerdex-assets.pages.dev");
    }
  });
  it("assetOriginForPage: gate off keeps the strict policy everywhere (Production today), except the separate POC rule", () => {
    const base = "https://azerdex-assets.pages.dev";
    for (const p of ["/", "/zones", "/zone/1420", "/object/1731", "/database"]) expect(assetOriginForPage(p, base, {}), p).toBeNull();
    expect(assetOriginForPage("/zone/1420", base, { AZERDEX_ZONE_MAPS: "0" })).toBeNull();
    expect(assetOriginForPage("/poc/maps/tirisfal", base, {})).toBe("https://azerdex-assets.pages.dev");
  });
  it("assetOriginForPage: only an allow-listed https origin is ever emitted (never wildcard, http, other hosts, userinfo, ports)", () => {
    const on = { AZERDEX_ZONE_MAPS: "1" };
    for (const bad of ["https://evil.example", "http://azerdex-assets.pages.dev", "https://azerdex-assets.pages.dev:8443", "https://u:p@azerdex-assets.pages.dev", "*", "https:", "//azerdex-assets.pages.dev"]) {
      expect(assetOriginForPage("/", bad, on), bad).toBeNull();
    }
    expect(assetOriginForPage("/", undefined, on)).toBeNull(); // unset base = same-origin assets, nothing to allow
    expect(assetOriginForPage("/", "/maps", on)).toBeNull();
  });
  it("the asset origin widens ONLY img-src and connect-src, and only when passed", () => {
    const base = { dev: false, turnstile: false, https: true };
    const off = buildPageCsp("n", { ...base, assetOrigin: null });
    const on = buildPageCsp("n", { ...base, assetOrigin: "https://azerdex-assets.pages.dev" });
    const dir = (csp: string, name: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + " "));
    expect(dir(on, "img-src")).toContain("https://azerdex-assets.pages.dev");
    expect(dir(on, "connect-src")).toContain("https://azerdex-assets.pages.dev");
    for (const d of ["script-src", "style-src", "default-src", "frame-src", "form-action"]) expect(dir(on, d)).toBe(dir(off, d));
    expect(off).not.toContain("azerdex-assets");
  });
});

describe("architecture guards", () => {
  const SRC = join(__dirname, "../../src");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
  const files = walk(SRC);
  it("exactly one module drives Leaflet (no second map engine)", () => {
    const users = files.filter((f) => /from "leaflet"|import\("leaflet"\)/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
    expect(users).toEqual(["/components/maps/ZoneMapViewer.tsx"]);
  });
  it("coordinate conversion lives only in lib/maps/coordinates.ts", () => {
    const users = files.filter((f) => /\bpercentToLatLng\b/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
    expect(users.sort()).toEqual(["/components/maps/ZoneMapViewer.tsx", "/lib/maps/coordinates.ts"]);
  });
  it("the synthetic POC selector is used by the POC route only, never by zone/source/directory pages", () => {
    const users = files.filter((f) => /zone-observations/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length));
    expect(users).toEqual(["/app/poc/maps/tirisfal/page.tsx"]);
  });
  it("the map code never reads private tables or SQL directly", () => {
    for (const f of files.filter((x) => /\/(components|lib)\/maps\//.test(x))) expect(readFileSync(f, "utf8")).not.toMatch(/from "pg"|installation_|owner_user_id/);
  });
});
