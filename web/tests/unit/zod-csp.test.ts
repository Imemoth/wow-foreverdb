import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "@/lib/zod";

describe("Zod 4 CSP compatibility", () => {
  it("disables eval-based JIT for strict-CSP browser pages", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("loads all application schema imports through the pre-configured wrapper", () => {
    const root = join(process.cwd(), "src");
    const directImports: string[] = [];
    const scan = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { scan(path); continue; }
        if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || relative(root, path) === "lib/zod.ts") continue;
        const source = readFileSync(path, "utf8");
        if (/from\s*["']zod(?:\/[^"']*)?["']|require\(["']zod(?:\/[^"']*)?["']\)/.test(source)) {
          directImports.push(relative(root, path));
        }
      }
    };
    scan(root);
    expect(directImports).toEqual([]);
  });
});
