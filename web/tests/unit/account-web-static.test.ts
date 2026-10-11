import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Static guarantees of the PR B implementation (they read the source tree, so a later edit that weakens one of them fails CI
 * instead of passing review by accident). They complement tests/unit/account-boundary.test.ts (PR A).
 */
const SRC = resolve(__dirname, "../../src");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
};
const all = walk(SRC);
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");
const sourceFiles = all.filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));
const zone = sourceFiles.filter((f) => /^(lib\/account|app\/account)\//.test(rel(f)));
const routes = zone.filter((f) => /^app\/account\/api\/.+\/route\.ts$/.test(rel(f)));
const pages = zone.filter((f) => /\/(page|layout)\.tsx$/.test(rel(f)));
const clientFiles = zone.filter((f) => /^\s*["']use client["']/m.test(read(f)));
const importsOf = (p: string) => ts.preProcessFile(read(p), true, true).importedFiles.map((f) => f.fileName);
/** Strip comments so documentation that NAMES a forbidden thing does not trip the checks. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("account web zone (static)", () => {
  it("has the expected shape", () => {
    expect(routes.map(rel).sort()).toEqual([
      "app/account/api/confirm/route.ts", "app/account/api/csrf/route.ts", "app/account/api/forgot-password/route.ts", "app/account/api/login/route.ts",
      "app/account/api/logout/route.ts", "app/account/api/me/route.ts", "app/account/api/register/route.ts", "app/account/api/resend/route.ts",
      "app/account/api/reset-password/route.ts", "app/account/api/session/refresh/route.ts",
    ]);
    expect(existsSync(join(SRC, "app/api/account"))).toBe(false);
    expect(clientFiles.length).toBeGreaterThan(5);
  });

  it("every route handler is dynamic, exports only GET/POST, and every POST goes through the CSRF-enforcing accountApi wrapper", () => {
    for (const f of routes) {
      const text = code(f);
      expect(text, rel(f)).toMatch(/export const dynamic = "force-dynamic"/);
      const methods = [...text.matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      expect(methods.every((m) => m === "GET" || m === "POST"), `${rel(f)}: ${methods}`).toBe(true);
      expect(methods.length, rel(f)).toBe(1);
      if (methods[0] === "POST") expect(text, rel(f)).toMatch(/export const POST = accountApi\(\{[^}]*mutating: true/);
      expect(text, rel(f)).not.toMatch(/export const (revalidate|runtime|fetchCache)\b/);
    }
  });

  it("accountApi enforces disabled/unavailable, then CSRF, then a bounded strict body, before any handler code", () => {
    const text = code(join(SRC, "lib/account/handler.ts"));
    const order = ["rt.state === \"disabled\"", "rt.state === \"unavailable\"", "verifyCsrf(", "readBoundedJson(", "safeParse(", "return await fn("].map((s) => text.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("pages are never statically generated or cached: layout is force-dynamic, no page opts into static/revalidate", () => {
    expect(code(join(SRC, "app/account/layout.tsx"))).toMatch(/export const dynamic = "force-dynamic"/);
    for (const f of pages) expect(code(f), rel(f)).not.toMatch(/generateStaticParams|dynamic = "(force-static|auto|error)"|export const revalidate = [1-9]|unstable_cache|"use cache"/);
    expect(code(join(SRC, "app/account/layout.tsx"))).toMatch(/robots:\s*\{\s*index: false, follow: false/);
  });

  it("no Supabase client library, no getSession/getClaims authorization, no process.env, no service credentials in the zone", () => {
    // (config.ts and migration-conformance.ts only NAME the service role in order to refuse it; PR A's boundary test pins that.)
    for (const f of zone.filter((x) => !/^lib\/account\/(config|migration-conformance)\.ts$/.test(rel(x)))) {
      const text = code(f);
      expect(importsOf(f).filter((i) => /supabase|@supabase|gotrue|jose|jsonwebtoken|next-auth|iron-session/i.test(i)), rel(f)).toEqual([]);
      expect(text, rel(f)).not.toMatch(/\bgetSession\s*\(/);
      expect(text, rel(f)).not.toMatch(/process\.env/);
      expect(text, rel(f)).not.toMatch(/service[_-]?role|sb_secret_|SERVICE_ROLE/i);
    }
  });

  it("only lib/account/auth-client.ts contacts Auth; only turnstile.ts contacts Cloudflare; the browser helper calls same-origin paths only", () => {
    const fetchers = zone.filter((f) => /\bfetch\s*\(/.test(code(f))).map(rel).sort();
    expect(fetchers).toEqual(["lib/account/auth-client.ts", "lib/account/client.ts"]); // turnstile.ts calls an injected fetchImpl (default: fetch)
    expect(code(join(SRC, "lib/account/turnstile.ts"))).toMatch(/fetchImpl: typeof fetch = fetch/);
    expect(code(join(SRC, "lib/account/turnstile.ts"))).toContain("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    for (const m of code(join(SRC, "lib/account/client.ts")).matchAll(/fetch\(\s*([^,)]+)/g)) expect(m[1], "client fetch target").toMatch(/^("\/account\/api\/|path\b)/);
    // the wrapper checks every request against the closed allowlist
    const wrapper = code(join(SRC, "lib/account/auth-client.ts"));
    expect(wrapper).toMatch(/isAllowedAuthRequest\(spec\.method, spec\.pathAndQuery, \{ callbackUrl \}\)/);
    expect(wrapper).toMatch(/AUTH_BODIES\.(signup|password_grant|refresh_grant|verify|recover|resend|update_password)\.parse/);
    expect(wrapper).toMatch(/redirect: "manual"/);
    expect(wrapper).not.toMatch(/\.\.\.(init|options|req|request)\b/); // nothing is spread in from a caller
    // logout is pinned to the local scope and nothing derives a scope from input
    expect(wrapper).toContain("/auth/v1/logout?scope=local");
    expect(wrapper).not.toMatch(/scope=(global|others)/);
  });

  it("the session cookie is written and cleared only by session.ts; cookie names live there alone", () => {
    expect(zone.filter((f) => /fdb_acct|__Secure-fdb/.test(code(f))).map(rel)).toEqual(["lib/account/session.ts"]);
    const csrfWriters = zone.filter((f) => /setCookie\(|\.cookies\.set\(/.test(code(f))).map(rel).sort();
    expect(csrfWriters).toEqual(["app/account/api/csrf/route.ts", "lib/account/session.ts"]);
    const text = code(join(SRC, "lib/account/session.ts"));
    expect(text).toMatch(/path: "\/account"/);
    expect(text).not.toMatch(/path: "\/"[^\]]*maxAge: [^0]/); // the only Path=/ cookies are deletions (clearSession)
    expect(text).toMatch(/httpOnly: true/);
    expect(text).not.toMatch(/httpOnly: false/);
    expect(text).not.toMatch(/sameSite: "None"/i);
  });

  it("nothing logs request data: console is used only by the closed-field accountLog", () => {
    const users = zone.filter((f) => /\bconsole\./.test(code(f))).map(rel);
    expect(users).toEqual(["lib/account/http.ts"]);
    const text = code(join(SRC, "lib/account/http.ts"));
    expect(text).toMatch(/fields: \{ route\?: string; status\?: number; code\?: string \| null; kind\?: string \}/);
  });

  it("client components import only isomorphic account modules (contracts, client, messages, inputs) - never server modules or secrets", () => {
    for (const f of clientFiles) {
      const bad = importsOf(f).filter((i) => /account\/(auth-client|session|csrf|handler|runtime|limits|turnstile|http|crypto|config)\b/.test(i) || /server-only|next\/headers|^node:/.test(i));
      expect(bad, rel(f)).toEqual([]);
    }
    const comps = zone.filter((f) => /_components\//.test(rel(f)));
    expect(comps.every((f) => clientFiles.includes(f))).toBe(true);
    // the isomorphic modules they use stay free of Node built-ins and of Buffer
    for (const m of ["lib/account/contracts.ts", "lib/account/client.ts", "lib/account/messages.ts", "lib/account/inputs.ts", "lib/account/crypto.ts"]) {
      expect(importsOf(join(SRC, m)).filter((i) => /^node:|^server-only$/.test(i)), m).toEqual([]);
      expect(code(join(SRC, m)), m).not.toMatch(/\bBuffer\b/);
    }
  });

  it("the edge keeps its boundary: proxy.ts imports no account module and mentions no account secret", () => {
    const proxy = join(SRC, "proxy.ts");
    expect(importsOf(proxy).filter((i) => /account/.test(i))).toEqual([]);
    expect(read(proxy)).not.toMatch(/ACCOUNT_|accountAuth|csrfSecret/);
    const text = code(proxy);
    expect(text).toMatch(/isAccountPath\(pathname\)/);
    expect(text).toMatch(/!isAccount && !sessionId && request\.method === "GET"/); // no anonymous cookie on /account/**
    expect(text).toMatch(/"Cache-Control": "private, no-store"/);
    expect(text).toMatch(/"X-Robots-Tag": "noindex, nofollow"/);
    expect(text).toMatch(/isAccountApiPath\(pathname\)/);
  });

  it("the public data layer and the public search route stay free of account code and of account cookies", () => {
    for (const f of sourceFiles.filter((x) => /^(lib\/data|app\/api\/v1|app\/database|app\/item|app\/zone|lib\/api\.ts)/.test(rel(x)))) {
      expect(importsOf(f).filter((i) => /account/.test(i)), rel(f)).toEqual([]);
      expect(read(f), rel(f)).not.toMatch(/fdb_acct|fdb_csrf|ACCOUNT_/);
    }
  });

  it("robots and the sitemap do not advertise account routes", () => {
    for (const f of ["app/sitemap.ts", "app/robots.ts"]) expect(read(join(SRC, f)), f).not.toMatch(/\/account/);
  });
});
