import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The owner-run scripts talk to Discord. On Windows, calling process.exit() while fetch's connection is still closing aborts Node with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (seen on the first real registration, AFTER the request had succeeded). Once a script has
 * made a network call it must set process.exitCode and let the event loop drain. Exits BEFORE any request (argument refusals) are fine.
 */
const ROOT = new URL("..", import.meta.url).pathname;
const cases: Array<{ file: string; firstNetworkCall: string }> = [
  { file: "scripts/register-commands.ts", firstNetworkCall: "await fetch(" },
  { file: "scripts/staging-preflight.ts", firstNetworkCall: "await runPreflight(" },
];

describe("owner-run scripts exit cleanly after network calls", () => {
  it.each(cases)("$file never calls process.exit() after its first network call and ends with process.exitCode", ({ file, firstNetworkCall }) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const at = src.indexOf(firstNetworkCall);
    expect(at, "network call not found").toBeGreaterThan(0);
    const after = src.slice(at);
    expect(after).not.toMatch(/process\.exit\(/);
    expect(after).toMatch(/process\.exitCode\s*=/);
  });
  it.each(cases)("$file still refuses bad arguments with a non-zero exit before any request", ({ file, firstNetworkCall }) => {
    const src = readFileSync(join(ROOT, file), "utf8");
    const before = src.slice(0, src.indexOf(firstNetworkCall));
    expect(before).toMatch(/process\.exit\(2\)/);
  });
  it("the registration script consumes the response body so the connection can close", () => {
    expect(readFileSync(join(ROOT, "scripts/register-commands.ts"), "utf8")).toMatch(/await res\.arrayBuffer\(\)/);
  });
});
