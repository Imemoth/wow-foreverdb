import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Static guarantees of the zero-touch enrollment website half: they read the source tree so a later edit cannot quietly weaken them. */
const SRC = resolve(__dirname, "../../src");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
};
const all = walk(SRC).filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f));
const rel = (p: string) => relative(SRC, p).split(sep).join("/");
const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const zone = all.filter((f) => /^(lib\/account|app\/account)\//.test(rel(f)));
const importsOf = (p: string) => ts.preProcessFile(read(p), true, true).importedFiles.map((f) => f.fileName);
const route = (r: string) => join(SRC, `app/account/api/${r}/route.ts`);
const NEW_ROUTES = ["devices", "devices/revoke", "enrollment/download", "enrollment/revoke"];
const NEW_FILES = [...NEW_ROUTES.map((r) => `app/account/api/${r}/route.ts`), "app/account/devices/page.tsx", "app/account/_components/RevokeButton.tsx", "lib/account/contracts-enrollment.ts"];

describe("zero-touch enrollment (static)", () => {
  it("the website can name exactly the five account functions; no device_* function exists anywhere in the website source", () => {
    const text = code(join(SRC, "lib/account/rpc-client.ts"));
    expect(text).toMatch(/export const WEB_ENROLLMENT_RPCS = \[\s*"fdb_account_enrollment_ticket_issue",\s*"fdb_account_enrollment_tickets",\s*"fdb_account_enrollment_ticket_revoke",\s*"fdb_account_devices",\s*"fdb_account_device_revoke",\s*\] as const satisfies/);
    expect(all.filter((f) => /fdb_device_/.test(code(f))).map(rel)).toEqual([]);
    // the new registry is separate from the 0012-pinned one
    expect(code(join(SRC, "lib/account/contracts.ts"))).not.toMatch(/enrollment|fdb_account_device/);
  });

  it("only rpc-client.ts builds PostgREST URLs or calls fetch for the new feature; the new files never import a network or Supabase module", () => {
    for (const f of NEW_FILES) {
      const text = code(join(SRC, f));
      expect(text, f).not.toMatch(/\bfetch\s*\(|rest\/v1|auth\/v1|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
      expect(importsOf(join(SRC, f)).filter((i) => /supabase|^node:|auth-client|account\/session$|account\/crypto$/.test(i)), f).toEqual([]);
      expect(text, f).not.toMatch(/process\.env|service[_-]?role|sb_secret_|SERVICE_ROLE/i);
    }
    expect(all.filter((f) => /rest\/v1/.test(read(f))).map(rel)).toEqual(["lib/account/rpc-client.ts"]);
  });

  it("the download route is POST-only (no GET/HEAD/other export), form-protected, and never reads the request URL, cookies or headers itself", () => {
    const text = code(route("enrollment/download"));
    expect([...text.matchAll(/export (?:async function|const) (\w+)/g)].map((m) => m[1]).sort()).toEqual(["POST", "dynamic"]);
    expect(text).toMatch(/export const POST = accountApi\(\{ route: "enrollment_download", mutating: true, form: \{ body: INPUTS\.enrollmentDownload, back: "\/account\/devices" \} \}/);
    expect(text).toMatch(/export const dynamic = "force-dynamic"/);
    expect(text).not.toMatch(/searchParams|nextUrl|req\.url|cookies\(|c\.req|redirect\(|console\./);
    // exactly the required download headers
    expect(text).toContain('"Content-Disposition": `attachment; filename="${ACTIVATION_FILE_NAME}"`');
    expect(text).toContain('"Content-Type": "application/json"');
    expect(text).toContain('"Cache-Control": "private, no-store"');
    expect(text).toContain('"X-Robots-Tag": "noindex"');
    // the ticket is read once, to build the file, and nowhere else
    expect(text.match(/out\.data\.ticket\b/g)?.length).toBe(1);
    expect(text).toMatch(/buildActivationFile\(out\.data\.ticket, /);
  });

  it("the ticket value never reaches accountLog, a JSON route, a page, a component or the client helper", () => {
    for (const f of zone) {
      for (const m of code(f).matchAll(/accountLog\(([^;]*)\);/g)) expect(m[1], `${rel(f)}: ${m[0]}`).not.toMatch(/\bticket\b(?!_)|\bout\.data\b|\bfile\b|\bbody\b|\braw\b|\btoken\b(?!")/i);
    }
    const jsonRoutes = ["devices", "devices/revoke", "enrollment/revoke"].map((r) => code(route(r)));
    for (const text of jsonRoutes) expect(text).not.toMatch(/\.ticket\b|fdba1_|buildActivationFile|Content-Disposition/);
    for (const f of zone.filter((x) => /^\s*["']use client["']/m.test(read(x)))) expect(code(f), rel(f)).not.toMatch(/\.ticket\b|fdba1_|fdbact|Content-Disposition|\bblob\b|createObjectURL/i);
    const page = code(join(SRC, "app/account/devices/page.tsx"));
    expect(page).not.toMatch(/fdba1_|\.ticket\b|fdb_account_enrollment_ticket_issue|buildActivationFile/);
    // the only place a ticket secret is rendered into the file is lib/account/contracts-enrollment.ts + the one route
    expect(all.filter((f) => /buildActivationFile\(/.test(code(f))).map(rel).sort()).toEqual(["app/account/api/enrollment/download/route.ts", "lib/account/contracts-enrollment.ts"]);
    expect(all.filter((f) => /fdb_account_enrollment_ticket_issue/.test(code(f))).map(rel).sort()).toEqual(["app/account/api/enrollment/download/route.ts", "lib/account/contracts-enrollment.ts", "lib/account/rpc-client.ts"]);
  });

  it("the file download is a native form post: no client script handles it, the page carries no fetch and only the closed notice codes", () => {
    const page = code(join(SRC, "app/account/devices/page.tsx"));
    expect(page).toMatch(/<form method="post" action="\/account\/api\/enrollment\/download"/);
    expect(page).toMatch(/type="hidden" name=\{FORM_CSRF_FIELD\}/);
    expect(page).not.toMatch(/"use client"|onSubmit|onClick|dangerouslySetInnerHTML|localStorage|sessionStorage|document\./);
    expect(page).toMatch(/Object\.hasOwn\(DEVICE_MESSAGES, notice\)/);
    expect(page).toContain('requirePageUser("/account/devices")');
    const btn = code(join(SRC, "app/account/_components/RevokeButton.tsx"));
    expect(btn).toMatch(/\/account\/api\/devices\/revoke/);
    expect(btn).toMatch(/\/account\/api\/enrollment\/revoke/);
    expect(btn).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it("the form-post protection is in the shared wrapper and comes before any handler code", () => {
    const text = code(join(SRC, "lib/account/handler.ts"));
    const order = ["verifyFormRequest(", "readBoundedForm(req", "verifyFormToken(", "opts.form.body.safeParse(", "await fn({ req, ac, jar, stored }, parsed.data)"].map((s) => text.indexOf(s));
    expect(order.every((i) => i > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const csrf = code(join(SRC, "lib/account/csrf.ts"));
    expect(csrf).toMatch(/checkCsrf\(secret, token, csrfBinding\(session\), now\)/); // HMAC bound to the web session id
    // the failure redirect target is a fixed path from the route options plus a closed notice code, never request data
    expect(text).toMatch(/Object\.hasOwn\(DEVICE_MESSAGES, code\) \? code : "error"/);
  });

  it("the redirect allowlist contains the new page", () => {
    expect(code(join(SRC, "lib/account/contracts.ts"))).toMatch(/"\/account\/installations",\s*"\/account\/devices",/);
  });

  it("every new route authenticates through the approved resolver with the session's own token", () => {
    for (const r of NEW_ROUTES) {
      const text = code(route(r));
      expect(text, r).toMatch(/authenticate\(c(, \{ read: true \})?\)/);
      expect(text, r).toMatch(/\bsession\.at\b/);
      expect(text, r).toMatch(/export const dynamic = "force-dynamic"/);
      expect(text, r).not.toMatch(/process\.env|cookies\(\)|req\.headers\.get\("authorization"\)/i);
    }
  });

  it("the new UI is linked from the account overview and the installation list", () => {
    expect(code(join(SRC, "app/account/_ui/AccountDashboard.tsx"))).toContain('href="/account/devices"');
    expect(code(join(SRC, "app/account/installations/page.tsx"))).toContain('href="/account/devices"');
  });
});
