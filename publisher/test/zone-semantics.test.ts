import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicationConfig } from "../src/contract.js";
import { buildProjection, canonicalJson } from "../src/project.js";

/**
 * P2 regression: zone membership must never carry a zone-specific ITEM drop count.
 * Deterministic fixture: database/tests/fixtures/zone_semantics_export.json
 *   - creature 9001 observed in TWO zones (1420: 12 obs, 1421: 8 obs); bucket 100 obs;
 *     global drops: item 9101 = 40, item 9102 = 25
 *   - creature 9002 observed only in 1420 (5 obs); also drops item 9101 (10)  -> item 9101 GLOBAL = 50
 *   - no zone-specific item drop count exists anywhere in the data
 */
const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8")));
const exportJson = () => JSON.parse(readFileSync(resolve(__dirname, "../../database/tests/fixtures/zone_semantics_export.json"), "utf8"));
const build = () => buildProjection(exportJson(), config).projection;

describe("zone membership semantics (P2)", () => {
  it("the item appears in BOTH zones where its source was observed", () => {
    const p = build();
    const zonesOf = (id: number) => p.zone_entities.filter((e) => e.entity_kind === "item" && e.item_id === id).map((e) => e.map_id).sort();
    expect(zonesOf(9101)).toEqual([1420, 1421]);
    expect(zonesOf(9102)).toEqual([1420, 1421]);
    expect(zonesOf(9103)).toEqual([1420]); // gathering stays in its own zone
    expect(zonesOf(9104)).toEqual([1420]); // fishing stays in its own zone
  });

  it("item rows carry NO zone-specific count: observations is null, association is 'inferred'", () => {
    const p = build();
    const items = p.zone_entities.filter((e) => e.entity_kind === "item");
    expect(items).toHaveLength(6);
    for (const e of items) {
      expect(e.observations).toBeNull();
      expect(e.association).toBe("inferred");
    }
  });

  it("no zone claims the item's global drop count (50), nor any proportional share of it", () => {
    const p = build();
    const item = p.items.find((i) => i.item_id === 9101)!;
    expect(item.total_drops).toBe(50); // global, correctly labelled as such
    for (const e of p.zone_entities.filter((x) => x.item_id === 9101)) {
      expect(e.observations).toBeNull();
      // Guard against allocation schemes: no numeric field equals 50 / 40 / 10 / 25 / 12 / 8.
      expect([50, 40, 10, 25]).not.toContain(e.observations);
    }
  });

  it("associated_source_count is a structural count of DISTINCT in-zone sources", () => {
    const p = build();
    const n = (zone: number, id: number) => p.zone_entities.find((e) => e.map_id === zone && e.item_id === id)!.associated_source_count;
    expect(n(1420, 9101)).toBe(2); // creature 9001 + creature 9002
    expect(n(1421, 9101)).toBe(1); // creature 9001 only
    expect(n(1420, 9102)).toBe(1);
  });

  it("source rows keep their genuine, location-backed zone observations", () => {
    const p = build();
    const obs = (zone: number, id: number) => p.zone_entities.find((e) => e.map_id === zone && e.source_id === id)!;
    expect(obs(1420, 9001)).toMatchObject({ observations: 12, association: "observed", associated_source_count: null });
    expect(obs(1421, 9001)).toMatchObject({ observations: 8, association: "observed" });
    expect(obs(1420, 9002).observations).toBe(5);
    expect(obs(1420, 9301).observations).toBe(6); // gathering
    expect(obs(1420, 1420).observations).toBe(4); // fishing
  });

  it("zone aggregates are unchanged and measured (located observations, entity counts)", () => {
    const p = build();
    expect(p.zones.find((z) => z.map_id === 1420)).toMatchObject({ observations: 27, source_count: 4, item_count: 4 });
    expect(p.zones.find((z) => z.map_id === 1421)).toMatchObject({ observations: 8, source_count: 1, item_count: 2 });
  });

  it("search index keeps item observations as the GLOBAL drop total and keeps both zones in map_ids", () => {
    const p = build();
    const si = p.search_index.find((s) => s.entity_kind === "item" && s.item_id === 9101)!;
    expect(si.observations).toBe(50);
    expect(si.map_ids).toEqual([1420, 1421]);
  });

  it("drop-level statistics (global) are untouched by the zone fix", () => {
    const p = build();
    expect(p.drops.find((d) => d.item_id === 9101 && d.source_id === 9001)).toMatchObject({ drops: 40, observations: 100, rate: 0.4 });
    expect(p.drops.find((d) => d.item_id === 9101 && d.source_id === 9002)).toMatchObject({ drops: 10, observations: 50, rate: 0.2 });
  });

  it("is deterministic, and the committed web regression projection is exactly what the worker produces", () => {
    const a = buildProjection(exportJson(), config);
    expect(buildProjection(exportJson(), config).report.contentSha256).toBe(a.report.contentSha256);
    const committed = JSON.parse(readFileSync(resolve(__dirname, "../../web/tests/fixtures/zone-semantics.projection.json"), "utf8"));
    expect(canonicalJson(committed.projection)).toBe(canonicalJson(a.projection));
    expect(committed.report.contentSha256).toBe(a.report.contentSha256);
  });
});
