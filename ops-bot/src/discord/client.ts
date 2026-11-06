import { sanitizeText } from "../util/text";

export type DeliveryResult =
  | { ok: true; messageId: string | null }
  | { ok: false; class: "rate_limited" | "server" | "timeout" | "network" | "auth" | "client"; status?: number; retryAfterMs?: number };

export interface DiscordClient {
  createMessage(channelId: string, body: object, nonce: string): Promise<DeliveryResult>;
  editMessage(channelId: string, messageId: string, body: object): Promise<DeliveryResult>;
  editOriginalResponse(applicationId: string, interactionToken: string, body: object): Promise<DeliveryResult>;
}

const SNOWFLAKE = /^\d{17,20}$/;
const TOKEN = /^[A-Za-z0-9_-]{20,300}$/;

export interface RestClientOptions { apiBase: string; botToken: string; fetchFn?: typeof fetch; timeoutMs?: number; userAgent?: string }

export class DiscordRestClient implements DiscordClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly o: RestClientOptions) { this.fetchFn = o.fetchFn ?? fetch; this.timeoutMs = o.timeoutMs ?? 5000; }

  createMessage(channelId: string, body: object, nonce: string): Promise<DeliveryResult> {
    if (!SNOWFLAKE.test(channelId)) return Promise.resolve({ ok: false, class: "client" });
    // `nonce` + `enforce_nonce` lets Discord drop a duplicate of a message whose first attempt timed out after being accepted.
    // This is best-effort de-duplication within Discord's short window, NOT a global exactly-once guarantee (see docs/ops-bot/design-decision-record.md).
    return this.call("POST", `/channels/${channelId}/messages`, { ...body, nonce: nonce.slice(0, 25), enforce_nonce: true }, true);
  }
  editMessage(channelId: string, messageId: string, body: object): Promise<DeliveryResult> {
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) return Promise.resolve({ ok: false, class: "client" });
    return this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, body, true);
  }
  editOriginalResponse(applicationId: string, interactionToken: string, body: object): Promise<DeliveryResult> {
    if (!SNOWFLAKE.test(applicationId) || !TOKEN.test(interactionToken)) return Promise.resolve({ ok: false, class: "client" });
    return this.call("PATCH", `/webhooks/${applicationId}/${interactionToken}/messages/@original`, body, false);
  }

  private async call(method: string, path: string, body: object, withBotAuth: boolean): Promise<DeliveryResult> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.o.apiBase}${path}`, {
        method, signal: ac.signal, redirect: "error", body: JSON.stringify(body),
        headers: { "content-type": "application/json", "user-agent": this.o.userAgent ?? "AzerDexOpsBot (https://azerdex.com, 0.1.0)", ...(withBotAuth ? { authorization: `Bot ${this.o.botToken}` } : {}) },
      });
      if (res.ok) {
        let id: string | null = null;
        try { const j = (await res.json()) as { id?: unknown }; if (typeof j.id === "string" && SNOWFLAKE.test(j.id)) id = j.id; } catch { /* some endpoints return no body */ }
        return { ok: true, messageId: id };
      }
      if (res.status === 429) return { ok: false, class: "rate_limited", status: 429, retryAfterMs: await retryAfterMs(res) };
      if (res.status === 401 || res.status === 403) return { ok: false, class: "auth", status: res.status };
      if (res.status >= 500) return { ok: false, class: "server", status: res.status };
      return { ok: false, class: "client", status: res.status };
    } catch (e) {
      const aborted = (e as { name?: string }).name === "AbortError" || ac.signal.aborted;
      return { ok: false, class: aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function retryAfterMs(res: Response): Promise<number> {
  const header = res.headers.get("retry-after");
  let s = header === null || header.trim() === "" ? Number.NaN : Number(header); // Number(null) is 0: a MISSING header must not read as "retry now"
  if (!Number.isFinite(s) || s < 0) {
    try { const j = (await res.json()) as { retry_after?: unknown }; s = typeof j.retry_after === "number" ? j.retry_after : 5; } catch { s = 5; }
  }
  return Math.min(Math.max(Math.ceil(s * 1000), 1000), 15 * 60_000);
}

export const NO_MENTIONS = { parse: [] as string[] };
export const safe = (s: string, max?: number) => sanitizeText(s, max);
