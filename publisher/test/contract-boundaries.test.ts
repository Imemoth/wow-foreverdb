import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExportBucket,
  ExportDrop,
  ExportItem,
  ExportLocation,
  ExportMeta,
  ExportSource,
  LOOT_KINDS,
  PublicationConfig,
  SOURCE_TYPES,
} from "../src/core/contract.ts";
import { buildProjection, PublicationError } from "../src/core/project.ts";

const rawConfig = JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8"));
const config = PublicationConfig.parse(rawConfig);

function validExport() {
  return {
    meta: { contract_version: 1, exported_at: "2026-10-09T00:00:00Z", data_updated_at: "2026-10-09T00:00:00Z" },
    sources: [{ source_type: "creature", source_id: 1, source_level: 5, name: "Test Wolf", first_seen_at: null, last_seen_at: null }],
    items: [{ item_id: 10, name: "Wolf Meat", first_seen_at: null, last_seen_at: null }],
    buckets: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", observations: 200, installations: 3, max_installation_share: 0.5, last_updated_at: null }],
    drops: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", item_id: 10, drops: 50, quantity: 60, quest_drops: 0, installations: 3, max_installation_share: 0.5 }],
    locations: [{ source_type: "creature", source_id: 1, source_level: 5, loot_kind: "mob", map_id: 1420, zone_name: "Tirisfal Glades", subzone_name: "Brill", x: 41.5, y: 52.5, observations: 4, installations: 2 }],
  };
}
type Export = ReturnType<typeof validExport>;

function violation(ex: unknown): PublicationError {
  try {
    buildProjection(ex, config);
  } catch (e) {
    expect(e).toBeInstanceOf(PublicationError);
    return e as PublicationError;
  }
  throw new Error("expected buildProjection to fail closed, but it returned a projection");
}

describe("strict allowlist: unknown fields fail the whole run closed", () => {
  const CANARY = "LEAK-CANARY-installation-0123456789";

  it.each(["sources", "items", "buckets", "drops", "locations"] as const)("an extra column on a %s row", (section) => {
    const ex = validExport();
    (ex[section][0] as Record<string, unknown>).installation_id = CANARY;
    const err = violation(ex);
    expect(err.message).toBe("export_contract_violation");
    const issues = (err.detail as { issues: { path: string; code: string }[] }).issues;
    expect(issues).toEqual([{ path: `${section}.0`, code: "unrecognized_keys" }]);
  });

  it("an extra column on meta, and an extra top-level section", () => {
    const meta = validExport();
    (meta.meta as Record<string, unknown>).installation_id = CANARY;
    expect(violation(meta).message).toBe("export_contract_violation");
    const top = { ...validExport(), owner_user: [{ id: CANARY }] };
    expect(violation(top).message).toBe("export_contract_violation");
  });

  it("never echoes a private value or a column name into the error detail", () => {
    const ex = validExport();
    (ex.buckets[0] as Record<string, unknown>).installation_id = CANARY;
    (ex.items[0] as Record<string, unknown>).name = { nested: CANARY };
    const text = JSON.stringify(violation(ex).detail);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("installation_id");
    // detail carries only a bounded list of {path, code}
    for (const i of (violation(ex).detail as { issues: object[] }).issues) expect(Object.keys(i).sort()).toEqual(["code", "path"]);
  });

  it.each([
    ["top level", { ...rawConfig, extra: 1 }],
    ["thresholds", { ...rawConfig, thresholds: { ...rawConfig.thresholds, extra: 1 } }],
  ])("the publication config rejects an unknown key (%s)", (_where, cfg) => {
    expect(PublicationConfig.safeParse(cfg).success).toBe(false);
  });
});

describe("malformed exports fail closed with a PublicationError (never a raw exception)", () => {
  it.each([null, undefined, "export", 1, [], {}])("root value %j", (v) => {
    expect(violation(v).message).toBe("export_contract_violation");
  });

  it.each(["sources", "items", "buckets", "drops", "locations"] as const)("%s is not an array", (section) => {
    expect(violation({ ...validExport(), [section]: { 0: "x" } }).message).toBe("export_contract_violation");
    expect(violation({ ...validExport(), [section]: null }).message).toBe("export_contract_violation");
  });

  it("a missing section", () => {
    const { drops: _drops, ...rest } = validExport();
    expect(violation(rest).message).toBe("export_contract_violation");
  });
});

describe("numeric and date transformations keep their meaning", () => {
  it("timestamps become canonical ISO strings; null stays null", () => {
    const r = ExportMeta.parse({ contract_version: "1", exported_at: new Date("2026-03-04T05:06:07.890Z"), data_updated_at: null });
    expect(r).toEqual({ contract_version: 1, exported_at: "2026-03-04T05:06:07.890Z", data_updated_at: null });
    expect(ExportMeta.parse({ contract_version: 1, exported_at: "2026-03-04T05:06:07Z", data_updated_at: "2026-03-04" }).exported_at).toBe(
      "2026-03-04T05:06:07.000Z",
    );
  });

  it("bigint-like ids and counters: numbers and decimal strings both yield exact numbers", () => {
    const row = (source_id: unknown) =>
      ExportSource.parse({ source_type: "creature", source_id, source_level: 5, name: null, first_seen_at: null, last_seen_at: null }).source_id;
    expect(row(42)).toBe(42);
    expect(row("42")).toBe(42);
    expect(row("-184513")).toBe(-184513); // synthetic fishing-pool ids are negative
    expect(row(2 ** 31)).toBe(2 ** 31);
    expect(row(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("shares and coordinates: numeric strings (pg numeric) become numbers", () => {
    const b = ExportBucket.parse({ ...validExport().buckets[0], max_installation_share: "0.5" });
    expect(b.max_installation_share).toBe(0.5);
    expect(ExportBucket.parse({ ...validExport().buckets[0], max_installation_share: null }).max_installation_share).toBeNull();
    const l = ExportLocation.parse({ ...validExport().locations[0], x: "12.5", y: "7" });
    expect([l.x, l.y]).toEqual([12.5, 7]);
  });
});

describe("safe-integer behaviour: valid values are exact, anything not exactly representable is rejected, never rounded", () => {
  const meta = (contract_version: unknown) =>
    ExportMeta.safeParse({ contract_version, exported_at: null, data_updated_at: null });
  const item = (item_id: unknown) => ExportItem.safeParse({ item_id, name: null, first_seen_at: null, last_seen_at: null });

  it("accepts the whole safe-integer range at its edges", () => {
    for (const v of [0, 1, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, "7"]) expect(meta(v).success).toBe(true);
    expect(meta(Number.MAX_SAFE_INTEGER).data?.contract_version).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([2 ** 53, 2 ** 53 + 2, 1e21, -(2 ** 53), "9007199254740993", "1e21", Infinity, -Infinity, NaN, "Infinity", "abc", 1.5, undefined])(
    "rejects %j on an integer field",
    (v) => {
      expect(meta(v).success).toBe(false);
    },
  );

  it.each([2 ** 53, 1e21, 1.5, Infinity, NaN, "1.5", "abc", "", null, undefined, true])("rejects %j as a bigint-like id", (v) => {
    expect(item(v).success).toBe(false);
  });

  it("a rejected value fails the export instead of publishing a rounded number", () => {
    const ex = validExport();
    (ex.items[0] as Record<string, unknown>).item_id = 2 ** 53 + 2;
    expect(violation(ex).message).toBe("export_contract_violation");
  });
});

describe("oversized collections fail safely", () => {
  it("a huge number of invalid rows fails closed with a bounded, value-free report", () => {
    const ex = validExport();
    const CANARY = "LEAK-CANARY-row-value";
    ex.items = Array.from({ length: 20_000 }, () => ({ item_id: CANARY, name: null, first_seen_at: null, last_seen_at: null })) as unknown as Export["items"];
    const err = violation(ex);
    expect(err.message).toBe("export_contract_violation");
    expect((err.detail as { issues: unknown[] }).issues.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(err.detail)).not.toContain(CANARY);
  });
});

describe("publication allowlists are pinned (changing them widens the public data surface and needs review)", () => {
  it("source types and loot kinds", () => {
    expect([...SOURCE_TYPES]).toEqual(["creature", "gameobject", "fishing", "item"]);
    expect([...LOOT_KINDS]).toEqual(["mob", "skinning", "mining", "herbalism", "fishing", "fishing_pool", "chest", "gameobject", "disenchant"]);
  });

  it("the production publication config", () => {
    expect(config).toEqual({
      contractVersion: 1,
      locationGrid: 1,
      thresholds: {
        minBucketObservationsForRate: 10,
        lowConfidenceBelow: 30,
        highConfidenceAtLeast: 100,
        dominatedShare: 0.9,
        minLocationCellObservations: 2,
        maxRejectedRatio: 0.05,
        maxAnomalyRatio: 0.02,
      },
      allowedSourceTypes: ["creature", "gameobject", "fishing", "item"],
      allowedLootKinds: ["mob", "skinning", "mining", "herbalism", "fishing", "fishing_pool", "chest", "gameobject", "disenchant"],
      retainPublications: 3,
    });
  });

  it("the config schema only accepts values inside the allowlist", () => {
    expect(PublicationConfig.safeParse({ ...rawConfig, allowedSourceTypes: ["creature", "player"] }).success).toBe(false);
    expect(PublicationConfig.safeParse({ ...rawConfig, allowedLootKinds: ["mob", "mail"] }).success).toBe(false);
    expect(PublicationConfig.safeParse({ ...rawConfig, allowedSourceTypes: [] }).success).toBe(false);
    expect(PublicationConfig.safeParse({ ...rawConfig, contractVersion: 2 }).success).toBe(false);
    // ExportDrop stays strict too (quest_drops is read for completeness but is not allowlisted for publication)
    expect(ExportDrop.safeParse({ ...validExport().drops[0], installation_id: "x" }).success).toBe(false);
  });
});
