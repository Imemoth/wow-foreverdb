import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandler, DEFAULT_SIGNED_PATH } from "../../supabase/functions/azerdex-ops-health/handler";
import { createGatedReportSource, gateSignature, GATE_SIG_HEADER, GATE_TS_HEADER } from "../../supabase/functions/azerdex-ops-health/report-source";
import { signRequest } from "../src/health/http-provider";
import { parseHealthSnapshot } from "../src/health/contract";

/**
 * AZR-004 Option G against a REAL, version-pinned PostgREST (scripts/postgrest-pin.env) over HTTP, backed by a throwaway PostgreSQL that has 0019 + 0020 applied and the
 * hosted-like fixtures (authenticator NOINHERIT, anon/authenticated timeouts, pg_net open to PUBLIC, graphql_public stub). Verifies what no SQL simulation can:
 * that custom request headers reach the function, that RPC execution works, the EXACT HTTP status and body for every outcome, role isolation through real JWTs,
 * schema isolation, and the negative cases. Skipped unless scripts/ops-health-gated-rpc-tests.sh sets the environment. Secrets are generated per run and never printed;
 * every key and signature used is appended to a needle file that the script scans the server logs for.
 */
const BASE = process.env.OPS_HEALTH_POSTGREST_URL;
const JWT_SECRET = process.env.OPS_HEALTH_POSTGREST_JWT_SECRET ?? "";
const DB = process.env.OPS_HEALTH_DB;
const NEEDLES = process.env.OPS_HEALTH_NEEDLES_FILE;     // signatures: may appear in a verbose PostgreSQL log only
const KEYS_FILE = process.env.OPS_HEALTH_KEYS_FILE;       // keys: must appear in NO log, ever
const enabled = Boolean(BASE && JWT_SECRET && DB);

const needles = new Set<string>();
const keySet = new Set<string>();
const hmac = (key: string, ts: number) => { const s = createHmac("sha256", Buffer.from(key, "hex")).update(`${ts}\nGET\nops_health_report`).digest("hex"); needles.add(s); return s; };
const nowSec = () => Math.floor(Date.now() / 1000);
afterAll(() => {
  if (NEEDLES) appendFileSync(NEEDLES, [...needles].join("\n") + "\n");
  if (KEYS_FILE) appendFileSync(KEYS_FILE, [...keySet].join("\n") + "\n");
});

function psql(sql: string): string {
  return execFileSync("psql", ["-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1", "-d", DB!], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function rotate(overlap = "15 minutes"): string { const k = psql(`select ops_report.rotate_gate_key('${overlap}'::interval)`); keySet.add(k); return k; }
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(role: string, secret = JWT_SECRET): string {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role, exp: nowSec() + 300 })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
interface Res { status: number; headers: Headers; text: string; json: unknown }
async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const r = await fetch(`${BASE}${path}`, { method: init.method ?? "GET", headers: init.headers, body: init.body, redirect: "manual" });
  const text = await r.text();
  let json: unknown = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json };
}
const RPC = "/rpc/ops_health_report";
let KEY = "";       // created per file in beforeAll: files must not share a key (vitest orders and may run files in any order)
function gate(key = KEY, ts = nowSec()): Record<string, string> { return { [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: hmac(key, ts) }; }
const REFUSED = { code: "PT401", details: null, hint: null, message: "unauthorized" };

describe.skipIf(!enabled)("Option G over real PostgREST", () => {
  beforeAll(() => { KEY = rotate("0 seconds"); });
  it("starts from a fresh 64-hex gate key generated inside the database", () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
  });

  describe("accepted request", () => {
    it("GET /rpc/ops_health_report with the gate headers: 200, JSON, exactly the contract v1 report (custom headers reach the function, RPC executes as anon)", async () => {
      const r = await call(RPC, { headers: gate() });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^application\/json/);
      const parsed = parseHealthSnapshot(r.json);
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      expect(Object.keys(r.json as object).sort()).toEqual(["g6", "generatedAt", "overall", "schemaVersion", "sources"]);
      expect((r.json as { schemaVersion: number }).schemaVersion).toBe(1);
    });
    it("works with the apikey header a hosted gateway requires (ignored here), mixed-case header names, and an explicit anon JWT", async () => {
      const ts = nowSec();
      const mixed = await call(RPC, { headers: { "X-AzerDex-Gate-TS": String(ts), "X-AZERDEX-GATE-SIG": hmac(KEY, ts), apikey: "sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA" } });
      expect(mixed.status).toBe(200);
      expect((await call(RPC, { headers: { ...gate(), authorization: `Bearer ${jwt("anon")}` } })).status).toBe(200);
    });
    it("the real Edge source (report-source.ts) and the unchanged handler work against it end to end", async () => {
      const read = createGatedReportSource({ supabaseUrl: BASE!.replace(/\/$/, "") + "", apikey: "sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA", gateKeyHex: KEY, now: () => Date.now(), allowLocalhost: true, fetchFn: ((u: string, i: RequestInit) => fetch(u.replace("/rest/v1", ""), i)) as typeof fetch });
      const report = await read() as { schemaVersion: number };
      expect(report.schemaVersion).toBe(1);
      const SECRET = "h".repeat(40);
      const handler = createHandler({ secret: SECRET, signedPath: DEFAULT_SIGNED_PATH, now: () => Date.now(), readReport: read });
      const ts = nowSec();
      const res = await handler(new Request(`https://p.supabase.co${DEFAULT_SIGNED_PATH}`, { headers: { "x-azerdex-ops-timestamp": String(ts), "x-azerdex-ops-signature": await signRequest(SECRET, "GET", DEFAULT_SIGNED_PATH, ts) } }));
      expect(res.status).toBe(200);
      expect(parseHealthSnapshot(await res.json()).ok).toBe(true);
    });
    it("the Edge source's signature equals the independent Node HMAC the other tests use (one format, three implementations: SQL, report-source.ts, Node crypto)", async () => {
      const ts = nowSec(); expect(await gateSignature(KEY, ts)).toBe(hmac(KEY, ts));
    });
  });

  describe("refusals: one status, one body, no detail", () => {
    const cases: Record<string, () => { init: { method?: string; headers?: Record<string, string>; body?: string } }> = {
      "no headers": () => ({ init: {} }),
      "wrong signature": () => ({ init: { headers: { [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: "0".repeat(64) } } }),
      "signature of another timestamp": () => ({ init: { headers: { [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: hmac(KEY, nowSec() - 1) } } }),
      "valid signature, 2 minutes old": () => ({ init: { headers: gate(KEY, nowSec() - 120) } }),
      "valid signature, 2 minutes in the future": () => ({ init: { headers: gate(KEY, nowSec() + 120) } }),
      "malformed timestamp": () => ({ init: { headers: { [GATE_TS_HEADER]: "12ab", [GATE_SIG_HEADER]: hmac(KEY, nowSec()) } } }),
      "malformed signature": () => ({ init: { headers: { [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: "ZZ" } } }),
      "uppercase-hex signature": () => ({ init: { headers: { [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: hmac(KEY, nowSec()).toUpperCase() } } }),
      "unrelated key": () => ({ init: { headers: gate("ab".repeat(32)) } }),
      "only the timestamp": () => ({ init: { headers: { [GATE_TS_HEADER]: String(nowSec()) } } }),
      "only the signature": () => ({ init: { headers: { [GATE_SIG_HEADER]: hmac(KEY, nowSec()) } } }),
      "POST with a valid signature (GET only)": () => ({ init: { method: "POST", headers: { ...gate(), "content-type": "application/json" }, body: "{}" } }),
    };
    const bodies: string[] = [];
    for (const [name, make] of Object.entries(cases)) {
      it(`${name}: HTTP 401 with the exact refusal body`, async () => {
        const { init } = make();
        const r = await call(RPC, init);
        expect(r.status).toBe(401);
        expect(r.json).toEqual(REFUSED);
        bodies.push(r.text);
        for (const n of needles) expect(r.text + [...r.headers.entries()].join("\n")).not.toContain(n);
      });
    }
    it("every refusal body is byte-identical (no oracle for which check failed)", () => {
      expect(bodies.length).toBe(Object.keys(cases).length);
      expect(new Set(bodies).size).toBe(1);
    });
    it("a refusal never reveals the function, key, schema or SQL in headers either", async () => {
      const r = await call(RPC);
      const blob = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n").toLowerCase();
      for (const word of ["ops_report", "gate_keys", "hmac", "sql"]) expect(blob).not.toContain(word);
      expect(blob).not.toMatch(/\bpostgres\b/);          // "postgrest/12.x" in the Server header is the API server, not the database
    });
  });

  describe("role isolation through real JWTs (authenticator SET ROLE)", () => {
    it("authenticated and service_role JWTs with a VALID gate signature are denied: HTTP 403 / 42501 (they hold no EXECUTE)", async () => {
      for (const role of ["authenticated", "service_role"]) {
        const r = await call(RPC, { headers: { ...gate(), authorization: `Bearer ${jwt(role)}` } });
        expect(r.status, role).toBe(403);
        expect((r.json as { code: string }).code, role).toBe("42501");
      }
    });
    it("a JWT for postgres, the reporter, the pooler role or any role authenticator is not a member of cannot be impersonated: never 200, never reaches the function", async () => {
      for (const role of ["postgres", "supabase_admin", "azerdex_ops_reporter", "authenticator", "pg_read_all_data", "no_such_role"]) {
        const r = await call(RPC, { headers: { ...gate(), authorization: `Bearer ${jwt(role)}` } });
        expect([401, 403, 400], `${role}: ${r.status} ${r.text}`).toContain(r.status);
        expect(r.status === 200, role).toBe(false);
      }
    });
    it("a JWT signed with the wrong secret is rejected before any role switch: HTTP 401 PGRST301", async () => {
      const r = await call(RPC, { headers: { ...gate(), authorization: `Bearer ${jwt("anon", "x".repeat(40))}` } });
      expect(r.status).toBe(401);
      expect((r.json as { code: string }).code).toBe("PGRST301");
    });
    it("an authenticated or service_role JWT cannot call the ungated function or the operator functions either (not exposed, no grants)", async () => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        for (const fn of ["health", "gated_health", "rotate_gate_key", "revoke_gate", "gate_status"]) {
          const r = await call(`/rpc/${fn}`, { method: "POST", headers: { authorization: `Bearer ${jwt(role)}`, "content-type": "application/json" }, body: "{}" });
          expect(r.status, `${role}/${fn}`).toBe(404);
          expect((r.json as { code: string }).code).toBe("PGRST202");
        }
      }
    });
  });

  describe("schema and surface isolation", () => {
    it("ops_report and net are not exposed schemas: switching to them is HTTP 406 PGRST106, with or without a valid signature", async () => {
      for (const schema of ["ops_report", "net", "private", "cron", "pub"]) {
        for (const [method, header] of [["GET", "accept-profile"], ["POST", "content-profile"]] as const) {
          const r = await call("/rpc/gated_health", { method, headers: { ...gate(), [header]: schema, "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
          expect(r.status, `${schema} ${method}`).toBe(406);
          expect((r.json as { code: string }).code).toBe("PGRST106");
        }
      }
    });
    it("anon sees exactly one callable object in the default schema (OpenAPI follows privileges): the wrapper; graphql_public only its pre-existing stub", async () => {
      const def = await call("/", { headers: { accept: "application/openapi+json" } });
      expect(def.status).toBe(200);
      expect(Object.keys((def.json as { paths: object }).paths).sort()).toEqual(["/", RPC]);
      const gql = await call("/", { headers: { accept: "application/openapi+json", "accept-profile": "graphql_public" } });
      expect(Object.keys((gql.json as { paths: object }).paths).sort()).toEqual(["/", "/rpc/graphql"]);
    });
    it("no table, view or other function is reachable: the key table, ops_report objects and platform tables are 404 as anon", async () => {
      for (const path of ["/gate_keys", "/ops_report.gate_keys", "/news_sources", "/rpc/azerdex_news_health", "/rpc/health", "/rpc/rotate_gate_key"]) {
        const r = await call(path, { headers: { ...gate() } });
        expect([404], `${path} ${r.status}`).toContain(r.status);
      }
    });
  });

  describe("negative and abusive request shapes", () => {
    it("unknown arguments (query string or JSON body) are 404 PGRST202, never a report", async () => {
      expect((await call(`${RPC}?x=1`, { headers: gate() })).status).toBe(404);
      const post = await call(RPC, { method: "POST", headers: { ...gate(), "content-type": "application/json" }, body: JSON.stringify({ x: 1 }) });
      expect(post.status).toBe(404);
      expect((post.json as { code: string }).code).toBe("PGRST202");
    });
    it("unsupported verbs are refused by PostgREST before the function runs (PGRST101 405), even with a valid signature", async () => {
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const r = await call(RPC, { method, headers: gate() });
        expect(r.status, method).toBe(405);
      }
    });
    it("an oversized signature header (64 KB) is rejected at the transport layer, not executed", async () => {
      const r = await call(RPC, { headers: { [GATE_TS_HEADER]: String(nowSec()), [GATE_SIG_HEADER]: "a".repeat(65_536) } }).catch((e: unknown) => ({ status: 0, text: String(e) }));
      expect(r.status === 200).toBe(false);
    });
    it("a stray Authorization header that is not a JWT is PGRST301 (401), never the report", async () => {
      const r = await call(RPC, { headers: { ...gate(), authorization: "Bearer not-a-jwt" } });
      expect(r.status).toBe(401);
    });
    it("replay inside the 60-second window simply repeats the read-only report (documented and accepted; the key lifecycle tests below cover revocation)", async () => {
      const h = gate();
      expect((await call(RPC, { headers: h })).status).toBe(200);
      expect((await call(RPC, { headers: h })).status).toBe(200);
    });
  });

  describe("key lifecycle over HTTP", () => {
    it("rotation: the new key works at once; the previous key works during the overlap and stops when the overlap ends, with no further rotation", async () => {
      const old = KEY; const fresh = rotate("15 minutes");
      expect((await call(RPC, { headers: gate(fresh) })).status).toBe(200);
      expect((await call(RPC, { headers: gate(old) })).status).toBe(200);
      psql("update ops_report.gate_keys set expires_at = now() - interval '1 second' where slot = 'previous'");
      const r = await call(RPC, { headers: gate(old) });
      expect(r.status).toBe(401); expect(r.json).toEqual(REFUSED);
      expect((await call(RPC, { headers: gate(fresh) })).status).toBe(200);
      KEY = fresh;
    });
    it("revoke_gate is an instant kill switch: even a perfectly valid request is 401 straight away; a new key reopens the gate", async () => {
      psql("select ops_report.revoke_gate()");
      const r = await call(RPC, { headers: gate() });
      expect(r.status).toBe(401); expect(r.json).toEqual(REFUSED);
      KEY = rotate("0 seconds");
      expect((await call(RPC, { headers: gate() })).status).toBe(200);
    });
    it("an overlap of 0 cuts the previous key over immediately", async () => {
      const old = KEY; KEY = rotate("0 seconds");
      expect((await call(RPC, { headers: gate(old) })).status).toBe(401);
      expect((await call(RPC, { headers: gate(KEY) })).status).toBe(200);
    });
  });

  describe("a database failure behind the gate is a clean error, not a report", () => {
    it("when the G2 function fails the gate returns a PostgREST error (HTTP 4xx/5xx), never a healthy-looking body; the original G2 function is restored byte-for-byte", async () => {
      const fingerprint = () => psql("select md5(prosrc) || coalesce(proacl::text, '') || coalesce(proconfig::text, '') || proowner::regrole::text from pg_proc where oid = 'private.azerdex_news_health()'::regprocedure");
      const before = fingerprint();
      const definition = psql("select pg_get_functiondef('private.azerdex_news_health()'::regprocedure)");
      psql("create or replace function private.azerdex_news_health() returns jsonb language plpgsql as $$ begin raise exception 'simulated G2 outage'; end $$;");
      try {
        const r = await call(RPC, { headers: gate() });
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(parseHealthSnapshot(r.json).ok).toBe(false);
      } finally {
        psql(definition);
      }
      expect(fingerprint()).toBe(before);
      expect((await call(RPC, { headers: gate() })).status).toBe(200);
    });
  });
});
