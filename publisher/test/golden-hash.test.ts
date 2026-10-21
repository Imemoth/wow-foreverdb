import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PublicationConfig } from "../src/core/contract.ts";
import { buildProjection, canonicalJson } from "../src/core/project.ts";
import { syntheticExport } from "../src/core/synthetic.ts";

const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(__dirname, "../publication-config.json"), "utf8")));

/**
 * The content hash decides whether a run is a duplicate. These hashes were recorded BEFORE the single-pass index and
 * streaming-hash optimisations; they must never change unless the published content contract changes on purpose.
 */
describe("projection output is stable", () => {
  it.each([
    [1, "4df5e60812a910b30e8e2ddecc278136c5f84fa511f1fb759c9a4a9544d1ba86"],
    [3, "cf297ed26303a0c2"],
    [10, "372d257be7a949652fd969cd90fd21199aab764011d18d2ad46d64bd8ba2902d"],
  ])("synthetic scale %i has the recorded content hash", (scale, hash) => {
    const { report } = buildProjection(syntheticExport(scale), config);
    expect(report.contentSha256.startsWith(hash)).toBe(true);
  });

  it("is deterministic across runs", () => {
    const a = buildProjection(syntheticExport(2), config);
    const b = buildProjection(syntheticExport(2), config);
    expect(a.report.contentSha256).toBe(b.report.contentSha256);
    expect(canonicalJson(a.projection)).toBe(canonicalJson(b.projection));
  });

  it("canonical JSON sorts keys and matches JSON.stringify on sorted input", () => {
    expect(canonicalJson({ b: [1, { z: null, a: "x" }], a: true })).toBe('{"a":true,"b":[1,{"a":"x","z":null}]}');
  });
});
