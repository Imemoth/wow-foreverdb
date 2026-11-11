/**
 * Report source for the `azerdex-ops-health` Edge Function (AZR-004, Option G): reads the health report through the Supabase DATA API instead of a direct
 * PostgreSQL connection, so the function holds no database LOGIN credential. Runtime-agnostic (Web APIs only), unit-tested in Node and type-checked with Deno;
 * `index.ts` is the thin Deno wiring.
 *
 * Request: `GET <SUPABASE_URL>/rest/v1/rpc/ops_health_report` as plain `anon` (the `apikey` header carries the PUBLISHABLE key, which is public by design),
 * authorised by two headers: `x-azerdex-gate-ts` (unix seconds) and `x-azerdex-gate-sig` = hex(HMAC-SHA256(key, "<ts>\nGET\nops_health_report")). The key is a
 * 32-byte secret generated inside the database (`ops_report.rotate_gate_key()`) and stored as the Edge secret OPS_HEALTH_GATE_KEY (64 hex characters); it never
 * travels, and each signature is valid for 60 seconds. The database verifies it (database/ops/0020_ops_health_gated_rpc.sql).
 *
 * Failure behaviour: ANY problem (bad configuration, network error, timeout, a status other than 200, a redirect, an oversize or unparsable body) throws an Error
 * whose message is one of a fixed set of codes. Messages and thrown values never contain the URL, a header, the key, the signature or any part of a response, and
 * nothing is logged: the handler turns every throw into HTTP 503 `unavailable`, so the bot shows UNKNOWN and never reads silence as health.
 */
const encoder = new TextEncoder();

export const RPC_PATH = "/rest/v1/rpc/ops_health_report";
export const GATE_TS_HEADER = "x-azerdex-gate-ts";
export const GATE_SIG_HEADER = "x-azerdex-gate-sig";
export const SOURCE_TIMEOUT_MS = 7_000;       // below the handler's 8 s read bound, so a slow Data API surfaces as this source's own failure
export const MAX_BODY_BYTES = 65_536;         // the report is a few kilobytes; anything near this size is not our report

export type SourceErrorCode = "source_not_configured" | "source_network" | "source_timeout" | "source_status" | "source_redirect" | "source_body" | "source_signing";

export interface SourceDeps {
  /** The project URL, e.g. https://<ref>.supabase.co (the platform sets SUPABASE_URL). Must be https; plain http only for 127.0.0.1/localhost when allowLocalhost is set (tests). */
  supabaseUrl: string | undefined;
  /** The PUBLISHABLE (or legacy anon) API key for the `apikey` header. Public by design; it only selects the `anon` role. */
  apikey: string | undefined;
  /** The gate key, 64 hex characters (32 bytes), from ops_report.rotate_gate_key(). */
  gateKeyHex: string | undefined;
  now: () => number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  /** Tests only: allow http://127.0.0.1 or http://localhost. Never set by index.ts. */
  allowLocalhost?: boolean;
}

/** Every error this module throws: a fixed code, nothing else. */
export class SourceError extends Error {
  readonly code: SourceErrorCode;
  constructor(code: SourceErrorCode) { super(code); this.name = "SourceError"; this.code = code; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const API_KEY = /^[A-Za-z0-9._-]{20,400}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** hex(HMAC-SHA256(key, "<ts>\nGET\nops_health_report")): exactly what ops_report.gated_health() recomputes. */
export async function gateSignature(gateKeyHex: string, tsSec: number): Promise<string> {
  if (!HEX64.test(gateKeyHex) || !Number.isInteger(tsSec) || tsSec < 1_000_000_000 || tsSec > 9_999_999_999) throw new SourceError("source_signing");
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(gateKeyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${tsSec}\nGET\nops_health_report`)));
  } catch {
    throw new SourceError("source_signing");
  }
}

function endpoint(deps: SourceDeps): string {
  const raw = deps.supabaseUrl;
  if (!raw || !deps.apikey || !API_KEY.test(deps.apikey) || !deps.gateKeyHex || !HEX64.test(deps.gateKeyHex)) throw new SourceError("source_not_configured");
  let url: URL;
  try { url = new URL(raw); } catch { throw new SourceError("source_not_configured"); }
  const local = deps.allowLocalhost === true && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!(url.protocol === "https:" || (local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new SourceError("source_not_configured");
  }
  return `${url.origin}${RPC_PATH}`;
}

/** Returns the readReport function the handler expects. Configuration is validated on every call, before any request is made. */
export function createGatedReportSource(deps: SourceDeps): () => Promise<unknown> {
  return async () => {
    const target = endpoint(deps);
    const ts = Math.floor(deps.now() / 1000);
    const signature = await gateSignature(deps.gateKeyHex as string, ts);
    const fetchFn: typeof fetch = deps.fetchFn ?? ((input, init) => fetch(input, init));
    let res: Response;
    try {
      res = await fetchFn(target, {
        method: "GET",
        redirect: "manual",                                   // a redirect is never followed: it could carry the headers to another host
        signal: AbortSignal.timeout(deps.timeoutMs ?? SOURCE_TIMEOUT_MS),
        headers: { accept: "application/json", apikey: deps.apikey as string, [GATE_TS_HEADER]: String(ts), [GATE_SIG_HEADER]: signature },
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new SourceError(name === "TimeoutError" || name === "AbortError" ? "source_timeout" : "source_network");
    }
    try {
      if (res.status >= 300 && res.status < 400) throw new SourceError("source_redirect");
      if (res.status !== 200) throw new SourceError("source_status");
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new SourceError("source_body");
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) throw new SourceError("source_body");
      try { return JSON.parse(text) as unknown; } catch { throw new SourceError("source_body"); }
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError("source_body");
    } finally {
      try { await res.body?.cancel(); } catch { /* the body is already consumed or closed */ }
    }
  };
}
