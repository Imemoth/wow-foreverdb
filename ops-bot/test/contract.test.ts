import { describe, expect, it } from "vitest";
import { HEALTH_CONTRACT_VERSION, parseHealthSnapshot } from "../src/health/contract";
import { healthySnapshot, withSource } from "../src/health/mock-provider";
import { T0 } from "./helpers/fakes";

describe("health contract v1 (strict, versioned)", () => {
  it("accepts a valid healthy snapshot, including healthy_no_new_content", () => {
    const r = parseHealthSnapshot(healthySnapshot(T0));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.snapshot.sources[0]!.state).toBe("healthy_no_new_content");
    expect(HEALTH_CONTRACT_VERSION).toBe(1);
  });

  it("rejects an unknown schema version", () => {
    expect(parseHealthSnapshot({ ...healthySnapshot(T0), schemaVersion: 2 }).ok).toBe(false);
  });

  it("rejects unexpected fields anywhere (a payload cannot smuggle player/account data through)", () => {
    expect(parseHealthSnapshot({ ...healthySnapshot(T0), characterName: "Someone" }).ok).toBe(false);
    const snap = healthySnapshot(T0);
    expect(parseHealthSnapshot({ ...snap, sources: [{ ...snap.sources[0]!, accountEmail: "a@b.c" }] }).ok).toBe(false);
    expect(parseHealthSnapshot({ ...snap, g6: { ...snap.g6, command: "select 1" } }).ok).toBe(false);
  });

  it("rejects malformed fields and reports only JSON paths, never values", () => {
    const snap = withSource(healthySnapshot(T0), "blizzard-bluepost-us", { sourceKey: "Bad Key!! SECRET-VALUE" });
    const r = parseHealthSnapshot(snap);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.paths.join(" ")).toContain("sources.0.sourceKey");
      expect(JSON.stringify(r.paths)).not.toContain("SECRET-VALUE");
    }
  });

  it("rejects free-text causes, non-ISO timestamps, empty/oversized source lists and non-objects", () => {
    const snap = healthySnapshot(T0);
    expect(parseHealthSnapshot(withSource(snap, "blizzard-bluepost-us", { causes: ["Contains spaces and PII"] })).ok).toBe(false);
    expect(parseHealthSnapshot({ ...snap, generatedAt: "yesterday" }).ok).toBe(false);
    expect(parseHealthSnapshot({ ...snap, sources: [] }).ok).toBe(false);
    expect(parseHealthSnapshot({ ...snap, sources: Array.from({ length: 17 }, () => snap.sources[0]) }).ok).toBe(false);
    for (const bad of [null, "x", 5, [], undefined]) expect(parseHealthSnapshot(bad).ok).toBe(false);
  });

  it("accepts a new benign source state code (severity is authoritative, not the state name)", () => {
    expect(parseHealthSnapshot(withSource(healthySnapshot(T0), "blizzard-bluepost-us", { state: "some_future_state", severity: "ok" })).ok).toBe(true);
  });
});
