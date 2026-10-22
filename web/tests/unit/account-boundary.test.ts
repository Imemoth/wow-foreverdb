import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Static trust-boundary checks for the account (Auth-only) boundary. They read the source tree, so a future
 * change that wires account code into the public site, reads Auth configuration anywhere but env.ts, or adds a
 * generic forwarder fails CI instead of passing review by accident.
 *
 * Zone layout (ADR-015): account code lives ONLY in src/lib/account/** and src/app/account/** (pages and
 * route handlers under /account/api/*). There is no src/app/api/account: the session cookie is Path=/account.
 * The "zone" assertions are vacuously true until PR B adds files there; the "outside the zone" assertions are live now.
 */

const SRC = resolve(__dirname, "../../src");
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (SOURCE_FILE.test(name)) files.push(p);
  }
})(SRC);

const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");
const inZone = (r: string) => r.startsWith("lib/account/") || r.startsWith("app/account/");
/** Every module specifier the file can load: static imports, re-exports, dynamic import(), require(), import-type. */
const importsOf = (p: string) => ts.preProcessFile(read(p), true, true).importedFiles.map((f) => f.fileName);
const reachesAccount = (spec: string) => /(^|[/@])account(\/|$)/.test(spec);

describe("account boundary (static)", () => {
  it("scans every source flavour (ts, tsx, js, jsx, mjs, cjs, mts, cts)", () => {
    expect(SOURCE_FILE.test("a.cjs") && SOURCE_FILE.test("a.mts") && SOURCE_FILE.test("a.jsx") && SOURCE_FILE.test("a.cts")).toBe(true);
    expect(files.length).toBeGreaterThan(30);
  });
  it("only env.ts and the account zone may load account modules (plus the one header seam)", () => {
    const offenders = files.filter((f) => !inZone(rel(f)) && rel(f) !== "lib/env.ts").filter((f) => importsOf(f).some(reachesAccount)).map(rel);
    // The public-beta Account entry: SiteHeader may load exactly ONE module from the zone, the HeaderAccount seam, which
    // renders nothing unless Account is enabled and ready. Nothing else outside the zone may.
    expect(offenders).toEqual(["components/SiteHeader.tsx"]);
    expect(importsOf(join(SRC, "components/SiteHeader.tsx")).filter(reachesAccount)).toEqual(["@/app/account/_ui/HeaderAccount"]);
  });
  it("the header chrome never reads account configuration or session state itself", () => {
    for (const f of ["components/SiteHeader.tsx", "components/MobileNav.tsx"]) {
      expect(read(join(SRC, f)), f).not.toMatch(/accountRuntime|accountAuth|serverEnv|resolveSession|cookies\(|ACCOUNT_/);
    }
    expect(importsOf(join(SRC, "components/MobileNav.tsx")).filter(reachesAccount)).toEqual([]);
  });
  it("env.ts loads only the pure configuration module from the account zone", () => {
    expect(importsOf(join(SRC, "lib/env.ts")).filter(reachesAccount)).toEqual(["./account/config"]);
  });
  it("Auth configuration and its secrets are referenced only by env.ts and the account zone", () => {
    const offenders = files.filter((f) => !inZone(rel(f)) && rel(f) !== "lib/env.ts").filter((f) => /ACCOUNT_AUTH|ACCOUNT_CSRF|accountAuth|csrfSecret/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it("nothing exposes Auth configuration to the browser (no NEXT_PUBLIC account variables, no client components in the zone read it)", () => {
    expect(files.filter((f) => /NEXT_PUBLIC_(ACCOUNT|SUPABASE)/.test(read(f))).map(rel)).toEqual([]);
    for (const f of files.filter((x) => inZone(rel(x)) && /^\s*["']use client["']/m.test(read(x)))) {
      expect(read(f), rel(f)).not.toMatch(/accountAuth|serverEnv|ACCOUNT_AUTH|csrfSecret|publishableKey/);
    }
  });
  it("env.accountAuth is only ever read inside the account zone", () => {
    const readers = files.filter((f) => /\.accountAuth\b/.test(read(f))).map(rel);
    expect(readers.filter((r) => !inZone(r) && r !== "lib/env.ts")).toEqual([]);
  });
  it("the public data layer, rate limiter and API helpers never touch account code", () => {
    const publicFiles = files.filter((f) => rel(f).startsWith("lib/data/") || rel(f).startsWith("lib/security/") || rel(f) === "lib/api.ts");
    expect(publicFiles.length).toBeGreaterThan(3);
    for (const f of publicFiles) expect(importsOf(f).filter(reachesAccount), rel(f)).toEqual([]);
  });
  it("the account zone never loads the public data layer, a database driver or the anonymous identity helpers", () => {
    for (const f of files.filter((x) => inZone(rel(x)))) {
      const bad = importsOf(f).filter((i) => /(^|\/)lib\/data(\/|$)|(^|\/)data(\/|$)|^pg(\/|$)|^postgres$|@upstash|security\/identity/.test(i));
      expect(bad, rel(f)).toEqual([]);
    }
  });
  it("there is no /api/account route tree: the account API is /account/api/*, so the Path=/account cookie reaches it", () => {
    expect(existsSync(join(SRC, "app/api/account"))).toBe(false);
  });
  it("Auth and RPC URLs are built only in the allowlisted modules", () => {
    const AUTH_ALLOWED = new Set(["lib/account/contracts.ts", "lib/account/auth-client.ts"]);
    const RPC_ALLOWED = new Set(["lib/account/rpc-client.ts"]);
    expect(files.filter((f) => /\/auth\/v1\//.test(read(f)) && !AUTH_ALLOWED.has(rel(f))).map(rel)).toEqual([]);
    expect(files.filter((f) => /\/rest\/v1/.test(read(f)) && !RPC_ALLOWED.has(rel(f))).map(rel)).toEqual([]);
  });
  it("no service-role / secret key handling exists anywhere in the website source (the validators and the SQL linter only NAME the role to refuse or revoke it)", () => {
    const offenders = files.filter((f) => /service_role|SERVICE_ROLE|sb_secret_/.test(read(f)) && !/^lib\/(env|account\/config|account\/migration-conformance)\.ts$/.test(rel(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it("the private project reference is defined only by the two validators", () => {
    expect(files.filter((f) => /klxhikdlfwgxurdyexdi/.test(read(f))).map(rel).sort()).toEqual(["lib/account/config.ts", "lib/env.ts"]);
  });
});
