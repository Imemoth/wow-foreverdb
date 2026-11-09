import { parseHealthSnapshot } from "./contract";
import type { HealthProvider, ProviderResult } from "./provider";
import { toHex } from "../util/text";

const MAX_RESPONSE_BYTES = 262_144;

/** HMAC-SHA256 request signature: the shared secret never travels on the wire (unlike a bearer token). */
export async function signRequest(secret: string, method: string, path: string, timestampSec: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSec}\n${method}\n${path}`));
  return toHex(sig);
}

export interface HttpProviderOptions { url: string; secret: string; fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number }

/**
 * Client for the FUTURE protected reporting endpoint (designed in docs/ops-bot/supabase-reporting-contract.md, not deployed).
 * Read-only GET; strict response validation; every failure is classified, none throws.
 */
export class HttpHealthProvider implements HealthProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly opts: HttpProviderOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  async fetchSnapshot(): Promise<ProviderResult> {
    const url = new URL(this.opts.url);
    const ts = Math.floor(this.now() / 1000);
    const signature = await signRequest(this.opts.secret, "GET", url.pathname, ts);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url.toString(), {
        method: "GET", redirect: "manual", signal: ac.signal,
        headers: { accept: "application/json", "x-azerdex-ops-timestamp": String(ts), "x-azerdex-ops-signature": signature },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, failure: "auth", httpStatus: res.status };
      if (res.status === 429) {
        const header = res.headers.get("retry-after");
        const ra = header === null || header.trim() === "" ? Number.NaN : Number(header);
        return { ok: false, failure: "rate_limited", httpStatus: 429, ...(Number.isFinite(ra) && ra >= 0 ? { retryAfterMs: Math.min(ra * 1000, 60_000) } : {}) };
      }
      if (res.status >= 500) return { ok: false, failure: "server", httpStatus: res.status };
      if (res.status !== 200) return { ok: false, failure: "bad_response", httpStatus: res.status };
      if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return { ok: false, failure: "bad_response", httpStatus: 200 };
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) return { ok: false, failure: "bad_response", httpStatus: 200 };
      let json: unknown;
      try { json = JSON.parse(text); } catch { return { ok: false, failure: "contract", httpStatus: 200 }; }
      const parsed = parseHealthSnapshot(json);
      return parsed.ok ? { ok: true, snapshot: parsed.snapshot } : { ok: false, failure: "contract", httpStatus: 200 };
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError" || ac.signal.aborted;
      return { ok: false, failure: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}
