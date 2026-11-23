import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { requiresWebBuild } from "./vercel-ignored-build.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "vercel-ignored-build.mjs");

for (const path of [
  "docs/web/branch-policy.md",
  "database/migrations/0021_admin_private_evaluator.sql",
  "supabase/functions/azerdex-news-collector/index.ts",
  "publisher/src/core/index.ts",
  "addon/Core.lua",
  "companion/Companion.csproj",
  "Companion/Companion.csproj",
  ".github/workflows/web-ci.yml",
  ".mcp.json",
  "README.md",
  "web/tests/e2e/news.spec.ts",
  "web/docs/README.md",
]) {
  test(`skip non-web-only path: ${path}`, () => assert.equal(requiresWebBuild([path]), false));
}

for (const path of [
  "web/src/app/page.tsx",
  "web/src/lib/data/postgres-adapter.ts",
  "web/content/news/feature.md",
  "web/public/zones/hero/image.webp",
  "web/package.json",
  "web/package-lock.json",
  "web/next.config.ts",
  "web/vercel.json",
  "web/scripts/vercel-ignored-build.mjs",
  "scripts/map-atlas/generate.mjs",
  ".node-version",
  "not-yet-classified/a.txt",
]) {
  test(`build for web/unknown path: ${path}`, () => assert.equal(requiresWebBuild([path]), true));
}

test("mixed doc + web change builds", () => {
  assert.equal(requiresWebBuild(["docs/readme.md", "database/001.sql", "web/src/app/page.tsx"]), true);
});
test("no files, invalid path, and malformed arguments build", () => {
  for (const value of [[], null, undefined, ["../odd"], ["\\unsafe"], [""], [17]]) {
    assert.equal(requiresWebBuild(value), true);
  }
});
test("rename spanning from safe to web builds", () => {
  assert.equal(requiresWebBuild(["docs/example.md", "web/src/example.ts"]), true);
});

test("integration: ignored build from web/ detects root-wide changes and fails open", () => {
  const root = mkdtempSync(join(tmpdir(), "azerdex-vercel-filter-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path, text) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  const run = (base) => spawnSync(process.execPath, [script], {
    cwd: join(root, "web"),
    env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: base },
    encoding: "utf8",
  });
  try {
    git("init", "-q");
    git("config", "user.email", "ci@example.invalid");
    git("config", "user.name", "CI Test");
    write("web/src/app/page.tsx", "export default function Page() { return null }\n");
    write("README.md", "Initial docs\n");
    git("add", ".");
    git("commit", "-qm", "baseline");
    const base = git("rev-parse", "HEAD");

    write("docs/deployment.md", "Docs-only edit\n");
    git("add", ".");
    git("commit", "-qm", "docs only");
    const docsResult = run(base);
    assert.equal(docsResult.status, 0, docsResult.stdout + docsResult.stderr);

    write("database/migrations/0022_example.sql", "select 1;\n");
    git("add", ".");
    git("commit", "-qm", "backend only");
    const backendResult = run(base);
    assert.equal(backendResult.status, 0, backendResult.stdout + backendResult.stderr);

    write(".node-version", "24\n");
    git("add", ".");
    git("commit", "-qm", "root config");
    const configResult = run(base);
    assert.equal(configResult.status, 1, configResult.stdout + configResult.stderr);

    write("web/src/app/page.tsx", "export default function Page() { return 1 }\n");
    git("add", ".");
    git("commit", "-qm", "web change");
    const webResult = run(base);
    assert.equal(webResult.status, 1, webResult.stdout + webResult.stderr);

    const invalidBase = run("");
    assert.equal(invalidBase.status, 1, invalidBase.stdout + invalidBase.stderr);
    const missingHistory = run("a".repeat(40));
    assert.equal(missingHistory.status, 1, missingHistory.stdout + missingHistory.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
