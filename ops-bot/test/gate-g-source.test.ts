import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHandler, DEFAULT_SIGNED_PATH } from "../../supabase/functions/azerdex-ops-health/handler";
import { createGatedReportSource, gateSignature, GATE_SIG_HEADER, GATE_TS_HEADER, MAX_BODY_BYTES, RPC_PATH, SourceError, type SourceDeps } from "../../supabase/functions/azerdex-ops-health/report-source";
import { signRequest } from "../src/health/http-provider";
import { healthySnapshot } from "../src/health/mock-provider";

/**
 * AZR-004 Option G: the Edge Function's gated Data API report source (supabase/functions/azerdex-ops-health/report-source.ts) and the static guarantees about the
 * function folder and the SQL. No database and no network here: the real SQL gate and real PostgREST are exercised by scripts/ops-health-gated-rpc-tests.sh
 * (gate-g-e2e / gate-g-http / gate-g-load tests).
 */
const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const APIKEY = "sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAA";
const URL_ = "https://abcdefghijklmnop.supabase.co";
const T = 1_794_400_000_000;     // ms; 1794400000 s
const FUNCTION_DIR = join(__dirname, "..", "..", "supabase", "functions", "azerdex-ops-health");
const hmac = (key: string, ts: number) => createHmac("sha256", Buffer.from(key, "hex")).update(`${ts}\nGET\nops_health_report`).digest("hex");

function deps(over: Partial<SourceDeps> = {}): SourceDeps {
  return { supabaseUrl: URL_, apikey: APIKEY, gateKeyHex: KEY, now: () => T, ...over };
}
function reply(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () => new Response([204, 205, 304].includes(status) ? null : body, { status, headers })) as unknown as typeof fetch;
}
const SECRET_MARKERS = [KEY, APIKEY, "abcdefghijklmnop", "SECRET-BODY-MARKER", hmac(KEY, T / 1000)];
/** Every way an error can be rendered into a log or a message. */
function renderings(error: unknown): string {
  const e = error as Error & { cause?: unknown };
  return [String(error), e.message, e.stack ?? "", JSON.stringify(error, Object.getOwnPropertyNames(error as object)), JSON.stringify(e.cause ?? null)].join("\n");
}
async function failure(d: SourceDeps): Promise<SourceError> {
  try { await createGatedReportSource(d)(); } catch (e) { return e as SourceError; }
  throw new Error("expected the source to fail");
}

describe("gate signature: the exact bytes the database recomputes", () => {
  it("matches an independent Node HMAC and two pinned vectors (a change of the signed payload format breaks this test)", async () => {
    expect(await gateSignature(KEY, 1794400000)).toBe("0c78bc65f9cc9e4f448fc1c9f9d0c1903ae1b7ae7459de35f599083a25b360e4");
    expect(await gateSignature(KEY, 1794400060)).toBe("37414966b6908dc18b433aae6cfdbe2d1729abe4a834b50dba9a0ddeb0cb24bf");
    for (const ts of [1_000_000_000, 1_794_400_001, 9_999_999_999]) expect(await gateSignature(KEY, ts)).toBe(hmac(KEY, ts));
  });
  it("refuses anything that is not a 64-hex key and a 10-digit unix timestamp, with a code and nothing else", async () => {
    for (const [k, ts] of [["", 1794400000], [KEY.slice(1), 1794400000], [KEY.toUpperCase(), 1794400000], [KEY.replace(/^./, "g"), 1794400000], [KEY, 99], [KEY, 1.5], [KEY, 10_000_000_000]] as const) {
      await expect(gateSignature(k, ts)).rejects.toMatchObject({ code: "source_signing", message: "source_signing" });
    }
  });
  it("is deliberately not the external HMAC: a different key, payload and header set (the bot's secret and signing function are untouched)", async () => {
    expect(await gateSignature(KEY, 1794400000)).not.toBe(await signRequest(KEY, "GET", DEFAULT_SIGNED_PATH, 1794400000));
  });
});

describe("request shape", () => {
  it("is a GET of /rest/v1/rpc/ops_health_report with exactly the apikey, accept and two gate headers, no Authorization, redirects not followed, a timeout", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await createGatedReportSource(deps({ fetchFn }))()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${URL_}${RPC_PATH}`);
    expect(RPC_PATH).toBe("/rest/v1/rpc/ops_health_report");
    const init = seen[0]!.init;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["accept", "apikey", GATE_SIG_HEADER, GATE_TS_HEADER].sort());
    expect(headers.apikey).toBe(APIKEY);
    expect(headers[GATE_TS_HEADER]).toBe("1794400000");
    expect(headers[GATE_SIG_HEADER]).toBe(hmac(KEY, 1794400000));
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });
  it("signs with the clock at call time, so every call carries a fresh 60-second signature", async () => {
    let now = T; const seen: string[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { seen.push((init.headers as Record<string, string>)[GATE_TS_HEADER]!); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const read = createGatedReportSource(deps({ fetchFn, now: () => now }));
    await read(); now += 61_000; await read();
    expect(seen).toEqual(["1794400000", "1794400061"]);
  });
  it("accepts a localhost http URL only when a test explicitly allows it", async () => {
    const fetchFn = vi.fn(reply(200, "{}"));
    await expect(createGatedReportSource(deps({ supabaseUrl: "http://127.0.0.1:3000", fetchFn }))()).rejects.toMatchObject({ code: "source_not_configured" });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(createGatedReportSource(deps({ supabaseUrl: "http://127.0.0.1:3000", fetchFn, allowLocalhost: true }))()).resolves.toEqual({});
    await expect(createGatedReportSource(deps({ supabaseUrl: "http://example.com", fetchFn, allowLocalhost: true }))()).rejects.toMatchObject({ code: "source_not_configured" });
  });
});

describe("fail closed, with a fixed error vocabulary", () => {
  it("every non-200 status is an error (3xx is its own code); no response text or header is ever read into the error", async () => {
    for (const status of [301, 302, 307, 308]) expect(await failure(deps({ fetchFn: reply(status, "SECRET-BODY-MARKER", { location: "https://evil.example/SECRET-BODY-MARKER" }) }))).toMatchObject({ code: "source_redirect" });
    for (const status of [201, 204, 400, 401, 403, 404, 406, 429, 500, 502, 503, 504]) expect(await failure(deps({ fetchFn: reply(status, "SECRET-BODY-MARKER") }))).toMatchObject({ code: "source_status" });
  });
  it("unparsable, empty and oversize bodies are errors", async () => {
    for (const body of ["", "not json SECRET-BODY-MARKER", "{\"a\":"]) expect(await failure(deps({ fetchFn: reply(200, body) }))).toMatchObject({ code: "source_body" });
    expect(await failure(deps({ fetchFn: reply(200, "{}", { "content-length": String(MAX_BODY_BYTES + 1) }) }))).toMatchObject({ code: "source_body" });
    expect(await failure(deps({ fetchFn: reply(200, JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES) })) }))).toMatchObject({ code: "source_body" });
  });
  it("network errors and timeouts are errors; a transport error that carries secrets in its message or cause is reduced to a code", async () => {
    const leaky = (async () => { throw Object.assign(new TypeError(`fetch failed ${URL_}${RPC_PATH} apikey=${APIKEY} key=${KEY}`), { cause: new Error(`sig=${hmac(KEY, T / 1000)}`) }); }) as unknown as typeof fetch;
    const net = await failure(deps({ fetchFn: leaky }));
    expect(net).toMatchObject({ code: "source_network", message: "source_network" });
    for (const marker of SECRET_MARKERS) expect(renderings(net)).not.toContain(marker);
    const hang = ((_u: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    expect(await failure(deps({ fetchFn: hang, timeoutMs: 25 }))).toMatchObject({ code: "source_timeout" });
  });
  it("bad configuration is refused before any request is made (fetch is never called)", async () => {
    const bad: Partial<SourceDeps>[] = [
      { supabaseUrl: undefined }, { supabaseUrl: "" }, { supabaseUrl: "not a url" }, { supabaseUrl: "http://abcdefghijklmnop.supabase.co" }, { supabaseUrl: `${URL_}/rest/v1` },
      { supabaseUrl: `${URL_}?x=1` }, { supabaseUrl: "https://user:pw@abcdefghijklmnop.supabase.co" }, { supabaseUrl: `${URL_}#frag` },
      { apikey: undefined }, { apikey: "short" }, { apikey: "has space xxxxxxxxxxxxxxxxxxxxxxxx" },
      { gateKeyHex: undefined }, { gateKeyHex: "" }, { gateKeyHex: KEY.slice(1) }, { gateKeyHex: `${KEY}0` }, { gateKeyHex: KEY.toUpperCase() }, { gateKeyHex: "z".repeat(64) },
    ];
    for (const over of bad) {
      const fetchFn = vi.fn(reply(200, "{}"));
      const err = await failure(deps({ ...over, fetchFn }));
      expect(err).toMatchObject({ code: "source_not_configured", message: "source_not_configured" });
      expect(fetchFn).not.toHaveBeenCalled();
      for (const marker of SECRET_MARKERS) expect(renderings(err)).not.toContain(marker);
    }
  });
  it("nothing is logged on success or on any failure", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    await createGatedReportSource(deps({ fetchFn: reply(200, "{}") }))();
    for (const fetchFn of [reply(401, "x"), reply(200, "nope"), (async () => { throw new Error(KEY); }) as unknown as typeof fetch]) await failure(deps({ fetchFn }));
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});

describe("with the unchanged external handler", () => {
  const SECRET = "s".repeat(40);
  const make = (fetchFn: typeof fetch) => createHandler({ secret: SECRET, signedPath: DEFAULT_SIGNED_PATH, now: () => T, readReport: createGatedReportSource(deps({ fetchFn })) });
  const signedRequest = async () => {
    const ts = Math.floor(T / 1000);
    return new Request(`https://project.supabase.co${DEFAULT_SIGNED_PATH}`, { headers: { "x-azerdex-ops-timestamp": String(ts), "x-azerdex-ops-signature": await signRequest(SECRET, "GET", DEFAULT_SIGNED_PATH, ts) } });
  };
  it("a report from the Data API is served through the same allow-list projection as before (HTTP 200, contract v1)", async () => {
    const report = healthySnapshot(T) as unknown as Record<string, unknown>;
    const res = await make(reply(200, JSON.stringify({ ...report, injected: "dropped" })))(await signedRequest());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.schemaVersion).toBe(1);
    expect(body).not.toHaveProperty("injected");
  });
  it("every source failure is HTTP 503 `unavailable` with no detail; a malformed report is 502 `invalid_report`; a wrong external secret is still a uniform 401 before the source runs", async () => {
    for (const fetchFn of [reply(401, "SECRET-BODY-MARKER"), reply(500, "x"), reply(200, "nope"), (async () => { throw new Error(KEY); }) as unknown as typeof fetch]) {
      const res = await make(fetchFn)(await signedRequest());
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('{"error":"unavailable"}');
    }
    expect((await make(reply(200, JSON.stringify({ schemaVersion: 2 })))(await signedRequest())).status).toBe(502);
    const source = vi.fn(reply(200, "{}"));
    const res = await make(source)(new Request(`https://project.supabase.co${DEFAULT_SIGNED_PATH}`));
    expect(res.status).toBe(401);
    expect(source).not.toHaveBeenCalled();
  });
});

describe("static guarantees about the Edge Function folder and the SQL", () => {
  const files = readdirSync(FUNCTION_DIR).filter((f) => f.endsWith(".ts"));
  const text = (f: string) => readFileSync(join(FUNCTION_DIR, f), "utf8");
  it("the external contract file handler.ts is byte-for-byte the reviewed one (sha256 pinned)", () => {
    expect(createHash("sha256").update(readFileSync(join(FUNCTION_DIR, "handler.ts"))).digest("hex")).toBe("6a169e5b0fe526dab99752a7869079b42f1990a6746e7d94a5260b7f90d97088");
  });
  it("the function holds no database client, no connection string, and logs nothing", () => {
    expect(files.sort()).toEqual(["handler.ts", "index.ts", "report-source.ts"]);
    for (const f of files) {
      const t = text(f);
      expect(t, f).not.toMatch(/console\s*\./);
      expect(t, f).not.toMatch(/deno\.land\/x\/postgres|from\s+["']pg["']|npm:pg|Client\s*\(/);
      expect(t, f).not.toMatch(/OPS_HEALTH_DATABASE_URL|postgres(ql)?:\/\//i);
    }
  });
  it("reads exactly the expected environment variables, and no service-role or secret API key", () => {
    const names = new Set<string>();
    for (const f of files) for (const m of text(f).matchAll(/Deno\.env\.get\(\s*"([A-Z0-9_]+)"/g)) names.add(m[1]!);
    expect([...names].sort()).toEqual(["AZERDEX_OPS_HEALTH_SECRET", "AZERDEX_OPS_HEALTH_SIGNED_PATH", "OPS_HEALTH_APIKEY", "OPS_HEALTH_GATE_KEY", "SUPABASE_URL"]);
    for (const f of files) expect(text(f), f).not.toMatch(/SERVICE_ROLE|service_role|sb_secret_|SUPABASE_DB_URL|SUPABASE_ANON_KEY/);
  });
  it("supabase/config.toml still declares verify_jwt = false (authentication is the HMAC)", () => {
    expect(readFileSync(join(FUNCTION_DIR, "..", "..", "config.toml"), "utf8")).toMatch(/\[functions\.azerdex-ops-health\][^\[]*\nverify_jwt\s*=\s*false/);
  });
  const sql = readFileSync(join(__dirname, "..", "..", "database", "ops", "0020_ops_health_gated_rpc.sql"), "utf8");
  const blocks = sql.split(/create or replace function /i).slice(1);
  it("0020: five functions; every SECURITY DEFINER one pins search_path = pg_catalog; no dynamic SQL; no key-shaped literal", () => {
    expect(blocks).toHaveLength(5);
    for (const b of blocks) {
      if (/security definer/i.test(b)) expect(b.split(/\$\$/)[0], b.slice(0, 40)).toMatch(/set search_path = pg_catalog/);
      else expect(b.split(/\$\$/)[0], b.slice(0, 40)).toMatch(/security invoker/);
    }
    const code = sql.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bexecute\s+(format|'|\$|[a-z_]+\s*\()/i);
    expect(code).not.toMatch(/\b[0-9a-f]{64}\b/i);
  });
  it("0020: grants are exactly the intended ones (anon: schema USAGE, gated_health, the wrapper) and nothing is granted to PUBLIC, authenticated or service_role", () => {
    const code = sql.replace(/--.*$/gm, "");
    const grants = [...code.matchAll(/^grant\s+[^;]+;/gim)].map((m) => m[0].replace(/\s+/g, " ")).sort();
    expect(grants).toEqual(["grant execute on function ops_report.gated_health() to anon;", "grant execute on function public.ops_health_report() to anon;", "grant usage on schema ops_report to anon;"]);
  });
});
