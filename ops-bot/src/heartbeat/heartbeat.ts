/**
 * Independent heartbeat: the ONLY signal that does not pass through Supabase, D1's incident engine or Discord.
 * The external service (Healthchecks.io-compatible) alerts when pings STOP (missed Cloudflare cron) or when a /fail arrives.
 * Pings carry only a fixed vocabulary token: never error text, ids or URLs.
 */
export type HeartbeatSignal = "ok" | "supabase_degraded" | "delivery_failing" | "cycle_error" | "config_error" | "schedule_gap";

export interface HeartbeatProvider {
  /** Cycle completed: monitoring ran, state persisted, outbox processed. */
  success(signal: HeartbeatSignal): Promise<boolean>;
  /** Explicit failure of the BOT (not of Supabase): triggers the provider's alert route immediately. */
  fail(signal: HeartbeatSignal): Promise<boolean>;
  /** Informational event that must not page by itself (for example Supabase unreachable while the bot itself is fine). */
  log(signal: HeartbeatSignal): Promise<boolean>;
}

export class NoopHeartbeat implements HeartbeatProvider {
  async success(): Promise<boolean> { return true; }
  async fail(): Promise<boolean> { return true; }
  async log(): Promise<boolean> { return true; }
}

export class RecordingHeartbeat implements HeartbeatProvider {
  calls: Array<{ kind: "success" | "fail" | "log"; signal: HeartbeatSignal }> = [];
  async success(signal: HeartbeatSignal) { this.calls.push({ kind: "success", signal }); return true; }
  async fail(signal: HeartbeatSignal) { this.calls.push({ kind: "fail", signal }); return true; }
  async log(signal: HeartbeatSignal) { this.calls.push({ kind: "log", signal }); return true; }
}

export class HealthchecksHeartbeat implements HeartbeatProvider {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly pingUrl: string, fetchFn?: typeof fetch, private readonly timeoutMs = 4000) {
    const u = new URL(pingUrl);
    if (u.protocol !== "https:") throw new Error("heartbeat url must be https");
    this.fetchFn = fetchFn ?? fetch;
  }
  success(s: HeartbeatSignal) { return this.ping("", s); }
  fail(s: HeartbeatSignal) { return this.ping("/fail", s); }
  log(s: HeartbeatSignal) { return this.ping("/log", s); }
  private async ping(suffix: string, signal: HeartbeatSignal): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.pingUrl.replace(/\/$/, "")}${suffix}`, { method: "POST", body: signal, signal: ac.signal, redirect: "error", headers: { "content-type": "text/plain" } });
      return res.ok;
    } catch { return false; } finally { clearTimeout(timer); }
  }
}

/** A completely separate notification route used when Discord delivery itself is failing (generic JSON webhook: ntfy, Slack-style `text`, etc.). */
export interface FallbackNotifier { notify(text: string): Promise<boolean> }
export class NoopFallback implements FallbackNotifier { async notify() { return true; } }
export class RecordingFallback implements FallbackNotifier { sent: string[] = []; async notify(t: string) { this.sent.push(t); return true; } }
export class WebhookFallback implements FallbackNotifier {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly url: string, fetchFn?: typeof fetch, private readonly timeoutMs = 5000) {
    if (new URL(url).protocol !== "https:") throw new Error("fallback url must be https");
    this.fetchFn = fetchFn ?? fetch;
  }
  async notify(text: string): Promise<boolean> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.url, { method: "POST", signal: ac.signal, redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 500) }) });
      return res.ok;
    } catch { return false; } finally { clearTimeout(timer); }
  }
}
