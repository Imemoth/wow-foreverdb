import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicationConfig } from "../src/contract.js";
import { buildProjection, canonicalJson, displayKindOf, PublicationError } from "../src/project.js";
import { sanitizeName } from "../src/sanitize.js";
import { confidenceFor, wilson } from "../src/stats.js";

const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8")));
const synthetic = () =>
  JSON.parse(readFileSync(resolve(__dirname, "../../database/tests/fixtures/synthetic_private_export.json"), "utf8"));

function tiny(overrides: Partial<Record<string, unknown[]>> = {}) {
  return {
    meta: { contract_version: 1, exported_at: "2026-10-09T00:00:00Z", data_updated_at: "2026-10-09T00:00:00Z" },
    sources: [{ source_type: "creature", source_id: 1, source_level: 5, name: "Test Wolf", first_seen_at: null, last_seen_at: null }],
    items: [{ item_id: 10, name: "Wolf Meat", first_seen_at: null, last_seen_at: null }],
    buckets: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", observations: 200, installations: 3, max_installation_share: 0.5, last_updated_at: null }],
    drops: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", item_id: 10, drops: 50, quantity: 60, quest_drops: 0, installations: 3, max_installation_share: 0.5 }],
    locations: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", map_id: 1420, zone_name: "Tirisfal Glades", subzone_name: "Brill", x: 41.5, y: 52.5, observations: 4, installations: 2 }],
    ...overrides,
  };
}

describe("sanitizeName", () => {
  it.each([
    ["Copper Ore", true],
    ["Fishing - Tirisfal Glades", true],
    ["Garren's Haunt", true],
    ["Ün'Goro Crater", true],
    ["<img src=x onerror=alert(1)>", false],
    ["Evil\u0007Bell", false],
    ["Right‮Left", false],
    ["a".repeat(121), false],
    ["   ", false],
    ["{{constructor}}", false],
  ])("%j -> %s", (name, ok) => {
    expect(sanitizeName(name).ok).toBe(ok);
  });
});

describe("statistics", () => {
  it("wilson interval brackets the sample rate", () => {
    const [lo, hi] = wilson(50, 200);
    expect(lo).toBeLessThan(0.25);
    expect(hi).toBeGreaterThan(0.25);
    expect(lo).toBeGreaterThan(0.19);
  });
  it("suppresses rates under the sample threshold and caps dominated samples", () => {
    const t = config.thresholds;
    expect(confidenceFor(5, false, t)).toBe("insufficient");
    expect(confidenceFor(20, false, t)).toBe("low");
    expect(confidenceFor(50, false, t)).toBe("medium");
    expect(confidenceFor(500, false, t)).toBe("high");
    expect(confidenceFor(500, true, t)).toBe("medium");
  });
});

describe("buildProjection", () => {
  it("builds the allowlisted projection with a correct denominator", () => {
    const { projection } = buildProjection(tiny(), config);
    expect(projection.drops[0]).toMatchObject({ drops: 50, observations: 200, rate: 0.25, confidence: "high", dominated: false });
    expect(projection.items[0]?.indexable).toBe(true);
    expect(projection.locations[0]).toMatchObject({ x: 42, y: 53, map_id: 1420 }); // re-quantized to 1.0 grid
    expect(projection.zones[0]).toMatchObject({ map_id: 1420, zone_name: "Tirisfal Glades", item_count: 1, source_count: 1 });
  });

  it("FAILS CLOSED when the export carries a non-allowlisted column", () => {
    const ex = tiny();
    (ex.buckets[0] as Record<string, unknown>).installation_id = "leak";
    expect(() => buildProjection(ex, config)).toThrowError(PublicationError);
    try { buildProjection(ex, config); } catch (e) {
      // Error details must not echo private values.
      expect(JSON.stringify((e as PublicationError).detail)).not.toContain("leak");
    }
  });

  it("FAILS CLOSED when too many rows are rejected", () => {
    const ex = tiny({
      items: [{ item_id: 10, name: "<script>", first_seen_at: null, last_seen_at: null }],
    });
    expect(() => buildProjection(ex, config)).toThrowError(/rejection_ratio_exceeded/);
  });

  it("drops invariant-violating rows and fails closed past the anomaly threshold", () => {
    const ex = tiny();
    (ex.drops[0] as unknown as Record<string, number>).drops = 999; // more drops than observations
    expect(() => buildProjection(ex, config)).toThrowError(/anomaly_ratio_exceeded/);
  });

  it("marks single-installation samples as dominated and never high confidence", () => {
    const ex = tiny();
    Object.assign(ex.buckets[0] as object, { installations: 1, max_installation_share: 1 });
    const { projection } = buildProjection(ex, config);
    expect(projection.drops[0]).toMatchObject({ dominated: true, confidence: "medium" });
  });

  it("suppresses low-sample location cells", () => {
    const ex = tiny();
    (ex.locations[0] as unknown as Record<string, number>).observations = 1;
    const { projection } = buildProjection(ex, config);
    expect(projection.locations).toHaveLength(0);
    expect(projection.zones).toHaveLength(1); // zone membership is still honest
  });

  it("labels synthetic negative GameObject IDs as fishing pools", () => {
    expect(displayKindOf("gameobject", -184513)).toBe("fishing_pool");
    expect(displayKindOf("gameobject", 1731)).toBe("object");
  });

  it("is deterministic (stable content hash) and leaks no private identifiers", () => {
    const a = buildProjection(synthetic(), config);
    const b = buildProjection(synthetic(), config);
    expect(a.report.contentSha256).toBe(b.report.contentSha256);
    const text = canonicalJson(a.projection);
    expect(text).not.toMatch(/synthetic-installation|CANARY|installation|owner_user|<img|\u0007/i);
    expect(a.report.rejected).toMatchObject({ item_disallowed_characters: 1, item_control_or_bidi_character: 1 });
  });
});
