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
      "app/account/api/confirm/route.ts", "app/account/api/csrf/route.ts", "app/account/api/devices/revoke/route.ts", "app/account/api/devices/route.ts",
      "app/account/api/enrollment/download/route.ts", "app/account/api/enrollment/revoke/route.ts", "app/account/api/forgot-password/route.ts",
      "app/account/api/guildbook/guilds/route.ts", "app/account/api/guildbook/members/route.ts", "app/account/api/installations/route.ts",
      "app/account/api/link/route.ts", "app/account/api/login/route.ts",
      "app/account/api/logout/route.ts", "app/account/api/me/route.ts", "app/account/api/register/route.ts", "app/account/api/resend/route.ts",
      "app/account/api/reset-password/revoke/route.ts", "app/account/api/reset-password/route.ts", "app/account/api/session/refresh/route.ts",
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
      // the two retired Guildbook routes are deny-by-default 404 stubs (asserted below), not accountApi handlers
      if (methods[0] === "POST" && !rel(f).includes("/guildbook/")) expect(text, rel(f)).toMatch(/export const POST = accountApi\(\{[^}]*mutating: true/);
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
    expect(fetchers).toEqual(["lib/account/auth-client.ts", "lib/account/client.ts", "lib/account/rpc-client.ts"]); // turnstile.ts calls an injected fetchImpl (default: fetch)
    expect(code(join(SRC, "lib/account/turnstile.ts"))).toMatch(/fetchImpl: typeof fetch = fetch/);
    expect(code(join(SRC, "lib/account/turnstile.ts"))).toContain("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    for (const m of code(join(SRC, "lib/account/client.ts")).matchAll(/fetch\(\s*([^,)]+)/g)) expect(m[1], "client fetch target").toMatch(/^("\/account\/api\/|path\b)/);
    // the wrapper checks every request against the closed allowlist
    const wrapper = code(join(SRC, "lib/account/auth-client.ts"));
    expect(wrapper).toMatch(/isAllowedAuthRequest\(spec\.method, spec\.pathAndQuery, \{ callbackUrl, recovery \}\)/);
    expect(wrapper).toMatch(/AUTH_BODIES\.(signup|password_grant|refresh_grant|verify|recover|resend|update_password)\.parse/);
    expect(wrapper).toMatch(/redirect: "manual"/);
    expect(wrapper).not.toMatch(/\.\.\.(init|options|req|request)\b/); // nothing is spread in from a caller
    // logout is pinned to the local scope and nothing derives a scope from input
    expect(wrapper).toContain("/auth/v1/logout?scope=local");
    // the ONLY global scope is the fixed one inside logoutAllAfterRecovery (recovery-only); nothing else, and never `others`
    expect(wrapper.match(/scope=global/g)?.length).toBe(1);
    expect(wrapper).toMatch(/async logoutAllAfterRecovery\(cfg: AccountAuthConfig, recoveryToken: string\)[\s\S]*?\/auth\/v1\/logout\?scope=global[\s\S]*?undefined, true\)/);
    expect(wrapper).not.toMatch(/scope=others/);
    expect(wrapper).not.toMatch(/scope=\$\{|scope="\s*\+/);
    // only the reset routes may call it
    const callers = zone.filter((f) => /logoutAllAfterRecovery\(/.test(code(f)) && !/auth-client\.ts$/.test(f)).map(rel).sort();
    expect(callers).toEqual(["app/account/api/reset-password/revoke/route.ts", "app/account/api/reset-password/route.ts"]);
  });

  it("PR E: the PostgREST client is closed (registry subset, fixed method/path, publishable key + user token, no redirects, bounded, no caller headers)", () => {
    const text = code(join(SRC, "lib/account/rpc-client.ts"));
    expect(text).toMatch(/export const WEB_RPCS = \[\s*"fdb_account_claim_redeem",\s*"fdb_account_installations",\s*\] as const satisfies/);
    expect(text).not.toMatch(/fdb_account_claim_start|fdb_installation_link_status/); // Companion-only functions are unreachable from the website
    expect(text).toMatch(/isAccountRpc\(name\)/);
    expect(text).toMatch(/\$\{cfg\.authOrigin\}\/rest\/v1\/rpc\/\$\{name\}/);
    expect(text).toMatch(/method: "POST"/);
    expect(text).toMatch(/redirect: "manual"/);
    expect(text).toMatch(/cache: "no-store"/);
    expect(text).toMatch(/credentials: "omit"/);
    expect(text).toMatch(/AbortSignal\.timeout\(TIMEOUT_MS\)/);
    expect(text).toMatch(/MAX_RESPONSE_BYTES/);
    expect(text).toMatch(/spec\.input as z\.ZodTypeAny\)\.parse\(input\)/);
    expect(text).toMatch(/spec\.output as z\.ZodTypeAny\)\.safeParse\(json\)/);
    // exactly four request headers, none taken from a caller; no Prefer / Profile / transaction headers, nothing spread in
    expect([...text.matchAll(/^\s{8}("?[A-Za-z-]+"?|apikey): /gm)].map((m) => m[1]).sort()).toEqual(["Accept", "Authorization", "\"Content-Type\"", "apikey"].sort());
    expect(text).not.toMatch(/prefer|profile|x-|\.\.\.(init|options|req|request|headers|input)\b/i);
    expect(text).not.toMatch(/process\.env|service[_-]?role|sb_secret_/i);
    expect(importsOf(join(SRC, "lib/account/rpc-client.ts")).filter((i) => /lib\/data|security\/identity|^pg$/.test(i))).toEqual([]);
  });

  it("PR E: the link route runs wrapper -> identity -> code shape -> password budget -> fresh password -> identity re-check -> link budget -> RPC, with the ORIGINAL session token", () => {
    const text = code(join(SRC, "app/account/api/link/route.ts"));
    const order = [
      "accountApi({ route: \"link\", mutating: true, body: INPUTS.link }", "authenticate(c)", "normalizeClaimCode(body.code)", "\"reauth\", user.id", "chargeEmail(c.ac.env, c.ac.cfg.csrfSecret, \"login\", user.email)",
      "confirmPassword(c.ac.cfg, user, body.password)", "recheckIdentity(c.ac.cfg, session)", "\"link\", user.id", "callWebRpc(c.ac.cfg, \"fdb_account_claim_redeem\", { p_code: code }, session.at)",
    ].map((m) => text.indexOf(m));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toMatch(/writeSession|fromAuthSession|passwordGrant|body\.code[^)]*(log|console)/);
    // nothing about the code or the password reaches a log call
    for (const m of text.matchAll(/accountLog\([^)]*\)/g)) expect(m[0]).not.toMatch(/code\b(?!:\s*(null|out\.|fresh))|password|body/);
  });

  it("PR E: reauth.ts never stores or returns the temporary session, checks the SAME user id and revokes with the pinned local logout", () => {
    const text = code(join(SRC, "lib/account/reauth.ts"));
    expect(text).toMatch(/temp\.user\.id\.toLowerCase\(\) === current\.id\.toLowerCase\(\)/);
    expect(text).toMatch(/auth\.getUser\(cfg, temp\.access_token\)/);
    expect(text).toMatch(/auth\.logout\(cfg, accessToken\)/);
    expect(text).not.toMatch(/writeSession|setCookie|NextResponse|jsonResponse|refresh_token|\.rt\b/);
    expect(text).toMatch(/cleanup: revoked \? "revoked" : "unconfirmed"/);
  });

  it("PR E: every private handler authenticates through the approved resolver and nothing takes ownership from the request", () => {
    for (const r of ["link", "installations"]) {
      const text = code(join(SRC, `app/account/api/${r}/route.ts`));
      expect(text, r).toMatch(/authenticate\(c(, \{ read: true \})?\)/);
      expect(text, r).toMatch(/\bsession\.at\b/);
      expect(text, r).not.toMatch(/process\.env|cookies\(\)|req\.headers\.get\("authorization"\)/i);
    }
    const priv = code(join(SRC, "lib/account/private.ts"));
    expect(priv).toMatch(/resolveSession\(c\.ac\.cfg, c\.jar, c\.ac\.https, \{ kind: "user", canWrite: true \}\)/);
    // the website has no Guildbook request body at all
    expect(code(join(SRC, "lib/account/inputs.ts"))).not.toMatch(/guildbook|GUILDBOOK_PAGE_SIZE/i);
  });

  it("PR E: the claim code is never placed in a URL, Web Storage, a cookie or a log by the linking UI", () => {
    const text = code(join(SRC, "app/account/_components/LinkForm.tsx"));
    expect(text).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|history\.(push|replace)State|router\.(push|replace)|searchParams|console\./);
    expect(text).not.toMatch(/\?code=|[?&]claim=/);
    expect(text).toMatch(/autoComplete="off"/);
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

  it("the Guildbook is Companion-local: the website has no Guildbook page, route, RPC or link", () => {
    const dashboard = code(join(SRC, "app/account/_ui/AccountDashboard.tsx"));
    expect(dashboard).not.toContain('href="/account/guildbook"');
    expect(dashboard).not.toContain("synchronized characters");
    expect(dashboard).not.toContain("sync your characters and guilds");
    // the page is unconditionally a 404: it imports nothing from the account libraries and never reaches an RPC or a session
    const page = code(join(SRC, "app/account/guildbook/page.tsx"));
    expect(page).toMatch(/notFound\(\);/);
    expect(importsOf(join(SRC, "app/account/guildbook/page.tsx"))).toEqual(["next/navigation"]);
    expect(page).not.toMatch(/callWebRpc|requirePageUser|FOREVERDB_DEPLOYMENT|GuildbookBrowser/);
    expect(existsSync(join(SRC, "app/account/_components/GuildbookBrowser.tsx"))).toBe(false);
    // the two retired API routes: deny-by-default 404, no authentication, no body parsing, no RPC
    for (const route of ["guildbook/guilds", "guildbook/members"]) {
      const file = join(SRC, `app/account/api/${route}/route.ts`);
      const routeCode = code(file);
      expect(importsOf(file), route).toEqual([]);
      expect(routeCode, route).not.toMatch(/callWebRpc|accountApi|authenticate|guarded|withSession|INPUTS|fdb_account_guildbook|rpc/i);
      expect(routeCode, route).toMatch(/export const POST = async \(\) => new Response\(null, \{ status: 404 \}\);/);
    }
    // no account source file other than the contracts registry (which pins migration 0012 for the conformance linter) names a Guildbook RPC
    for (const f of zone.filter((x) => rel(x) !== "lib/account/contracts.ts")) expect(read(f), rel(f)).not.toMatch(/fdb_account_guildbook/);
    expect(code(join(SRC, "lib/account/contracts.ts"))).not.toMatch(/\/account\/guildbook/); // not a login redirect target either
    // WEB_RPCS (the only RPC names the website client can call) has no Guildbook entry
    expect(code(join(SRC, "lib/account/rpc-client.ts"))).not.toMatch(/guildbook/i);
    // no navigation entry (header menu, installations, linking, dashboard, account home) links the dead page
    for (const f of zone) {
      if (/^app\/account\/guildbook\/|^app\/account\/api\/guildbook\//.test(rel(f))) continue;
      expect(code(f), rel(f)).not.toMatch(/\/account\/guildbook|Open Guildbook|BookIcon/);
    }
    expect(code(join(SRC, "app/account/installations/page.tsx"))).not.toMatch(/guild/i);
    expect(code(join(SRC, "app/account/_components/HeaderAccountMenu.tsx"))).not.toMatch(/guildbook/i);
    expect(code(join(SRC, "app/account/_components/LinkForm.tsx"))).not.toMatch(/guildbook/i);
    expect(code(join(SRC, "app/account/page.tsx"))).not.toMatch(/guildbook/i);
    // the installation list API and page expose no Guildbook figure (the database still returns a legacy `guild_count`; it is not forwarded)
    expect(code(join(SRC, "app/account/api/installations/route.ts"))).not.toMatch(/guild/i);
  });

  it("robots and the sitemap do not advertise account routes", () => {
    for (const f of ["app/sitemap.ts", "app/robots.ts"]) expect(read(join(SRC, f)), f).not.toMatch(/\/account/);
  });
});
