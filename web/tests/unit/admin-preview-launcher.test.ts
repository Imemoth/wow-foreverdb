import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const launcher = resolve(__dirname, "../../scripts/admin-preview.mjs");

function withEnvironmentDirectory(test: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "fdb-admin-preview-launcher-"));
  try { test(dir); }
  finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
}

function startFrom(dir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [launcher, "start"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 15_000,
    env: { PATH: process.env.PATH ?? "", HOME: dir, NODE_ENV: "test", NEXT_TELEMETRY_DISABLED: "1", ...extraEnv },
  });
}

describe("Admin preview launcher environment-file boundary", () => {
  it("fails closed with an actionable error when the environment directory cannot be listed", () => {
    withEnvironmentDirectory((dir) => {
      chmodSync(dir, 0o100); // Child can enter the directory but cannot enumerate it.
      const result = startFrom(dir);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/cannot inspect.*environment files/i);
      expect(result.stderr).toMatch(/permissions|readable/i);
    });
  });

  for (const name of [".env", ".env.local"]) {
    it(`refuses to start when ${name} is present`, () => {
      withEnvironmentDirectory((dir) => {
        writeFileSync(join(dir, name), "HARMLESS_TEST_VALUE=1\n");
        const result = startFrom(dir);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(name);
      });
    });
  }

  it("does not allow the former dotenv override to bypass the refusal", () => {
    withEnvironmentDirectory((dir) => {
      writeFileSync(join(dir, ".env.local"), "HARMLESS_TEST_VALUE=1\n");
      const result = startFrom(dir, { ADMIN_PREVIEW_ALLOW_DOTENV: "1" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(".env.local");
    });
  });
});
