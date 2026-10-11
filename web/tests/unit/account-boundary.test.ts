import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static trust-boundary checks for the account (Auth-only) boundary. They read the source tree, so a future
 * change that wires account code into the public site, or reads Auth configuration anywhere but env.ts,
 * fails CI instead of passing review by accident.
 */

const SRC = resolve(__dirname, "../../src");
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(p);
  }
})(SRC);

const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");
const inAccountZone = (r: string) => r.startsWith("lib/account/") || r.startsWith("app/account/") || r.startsWith("app/api/account/");
const importsOf = (code: string) => [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("account boundary (static)", () => {
  it("only env.ts and the account zone may import account modules", () => {
    const offenders = files
      .filter((f) => !inAccountZone(rel(f)) && rel(f) !== "lib/env.ts")
      .filter((f) => importsOf(read(f)).some((i) => /(^|\/)account(\/|$)/.test(i) && !/^\.?\.?\/?(about|accounts?-)/.test(i)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
  it("env.ts imports only the pure configuration module from the account zone", () => {
    const accountImports = importsOf(read(join(SRC, "lib/env.ts"))).filter((i) => /account/.test(i));
    expect(accountImports).toEqual(["./account/config"]);
  });
  it("the public data layer and rate limiter never touch account code or Auth configuration", () => {
    const publicFiles = files.filter((f) => rel(f).startsWith("lib/data/") || rel(f).startsWith("lib/security/") || rel(f) === "lib/api.ts");
    expect(publicFiles.length).toBeGreaterThan(3);
    for (const f of publicFiles) {
      const code = read(f);
      expect(importsOf(code).filter((i) => /account/.test(i)), rel(f)).toEqual([]);
      expect(code, rel(f)).not.toMatch(/ACCOUNT_AUTH|accountAuth/);
    }
  });
  it("the account zone never imports the public data layer, a database driver, or the rate-limit identity helpers", () => {
    for (const f of files.filter((x) => inAccountZone(rel(x)))) {
      const bad = importsOf(read(f)).filter((i) => /(^|\/)lib\/data(\/|$)|^pg$|^postgres$|@upstash|security\/identity/.test(i) || /^\.\.\/data(\/|$)/.test(i));
      expect(bad, rel(f)).toEqual([]);
    }
  });
  it("Auth configuration is read from the environment in exactly one place (env.ts)", () => {
    const readers = files.filter((f) => /process\.env\.ACCOUNT_AUTH|process\.env\[/.test(read(f)) && /ACCOUNT_AUTH/.test(read(f))).map(rel);
    expect(readers).toEqual([]);
  });
  it("no service-role / secret key handling exists anywhere in the website source", () => {
    const offenders = files.filter((f) => /service_role|SERVICE_ROLE|sb_secret_/.test(read(f)) && !/^lib\/(env|account\/config)\.ts$/.test(rel(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it("the private project reference is defined only by the two validators", () => {
    const offenders = files.filter((f) => /klxhikdlfwgxurdyexdi/.test(read(f))).map(rel).sort();
    expect(offenders).toEqual(["lib/account/config.ts", "lib/env.ts"]);
  });
  it("account code must never use a generic RPC or URL forwarder", () => {
    for (const f of files.filter((x) => inAccountZone(rel(x)))) {
      const code = read(f);
      expect(code, rel(f)).not.toMatch(/\/rest\/v1\/rpc\/\$\{(?!\s*name\s*\})/); // only the allowlisted-name form is ever acceptable
    }
  });
});
