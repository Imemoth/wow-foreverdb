#!/usr/bin/env node
// Vercel Ignored Build Step. Exit 0 = skip build; exit 1 = build.
// Fail open: any uncertainty must build, never silently suppress a web change.
import { execFileSync } from "node:child_process";

const SAFE_PREFIXES = [
  "docs/",
  "database/",
  "addon/",
  "addons/",
  "companion/",
  "Companion/",
  "desktop/",
  ".github/",
];
const SAFE_EXACT = new Set([
  ".mcp.json",
  "README.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "CHANGELOG.md",
]);
const SAFE_WEB_PREFIXES = ["web/tests/", "web/docs/"];
const SAFE_WEB_EXACT = new Set(["web/README.md"]);

export function requiresWebBuild(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return true;
  return paths.some((raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("/") || raw.includes("\\"))
      return true;
    const path = raw.replace(/^\.\//, "");
    if (SAFE_EXACT.has(path) || SAFE_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return false;
    if (SAFE_WEB_EXACT.has(path) || SAFE_WEB_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return false;
    // Includes all other web files, scripts, shared configs, root packages, unknown paths.
    return true;
  });
}

function run() {
  const base = process.env.VERCEL_GIT_PREVIOUS_SHA;
  if (!base || !/^[0-9a-f]{40}$/i.test(base)) {
    console.log("BUILD: first deployment or no valid previous SHA");
    return 1;
  }
  try {
    const diff = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
    );
    const paths = diff.split("\0").filter(Boolean);
    const build = requiresWebBuild(paths);
    console.log(`${build ? "BUILD" : "SKIP"}: ${paths.length} changed files compared to ${base.slice(0, 12)}`);
    return build ? 1 : 0;
  } catch (error) {
    console.log(`BUILD: cannot reliably compare Git history (${error.message})`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = run();
}
