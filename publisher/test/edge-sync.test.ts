import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("the Edge Function's copy of the core is byte-identical to publisher/src/core", () => {
  const script = resolve(__dirname, "../../scripts/sync-edge-core.mjs");
  const out = execFileSync("node", [script, "--check"], { encoding: "utf8" });
  expect(out).toContain("in sync");
});
