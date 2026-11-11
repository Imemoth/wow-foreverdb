import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DiscordRestClient } from "../src/discord/client";
import { HttpHealthProvider, signRequest } from "../src/health/http-provider";
import { fetchWithRetry } from "../src/health/retry";
import { MockHealthProvider, healthySnapshot, ok } from "../src/health/mock-provider";
import { HealthchecksHeartbeat, WebhookFallback } from "../src/heartbeat/heartbeat";
import { IDS, T0 } from "./helpers/fakes";

type F = typeof fetch;
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const hanging: F = (_u, init) => new Promise((_r, rej) => { (init!.signal as AbortSignal).addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); });

describe("DiscordRestClient", () => {
  const mk = (fetchFn: F, timeoutMs = 25) => new DiscordRestClient({ apiBase: "https://discord.com/api/v10", botToken: "TEST_BOT_TOKEN_CANARY_aaaaaaaaaaaaaaaaaaaaaaaa", fetchFn, timeoutMs });
  it("posts with bot auth, nonce + enforce_nonce, and returns the message id", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const r = await mk(async (u, i) => { seen = { url: String(u), init: i! }; return res(200, { id: "123456789012345678" }); }).createMessage(IDS.channel, { content: "x" }, "n".repeat(40));
    expect(r).toEqual({ ok: true, messageId: "123456789012345678" });
    expect(seen!.url).toBe(`https://discord.com/api/v10/channels/${IDS.channel}/messages`);
    const sent = JSON.parse(String(seen!.init.body)); expect(sent.enforce_nonce).toBe(true); expect(sent.nonce).toHaveLength(25);
    expect((seen!.init.headers as Record<string, string>).authorization).toMatch(/^Bot /);
    expect(seen!.init.redirect).toBe("manual"); // Workers does not implement "error" (see workers-runtime-compat.test.ts)
  });
  it("HTTP 429: Retry-After header (seconds) is honoured; JSON retry_after is used as fallback; bounded", async () => {
    expect(await mk(async () => res(429, {}, { "retry-after": "2.5" })).createMessage(IDS.channel, {}, "n")).toEqual({ ok: false, class: "rate_limited", status: 429, retryAfterMs: 2500 });
    expect(await mk(async () => res(429, { retry_after: 7 })).createMessage(IDS.channel, {}, "n")).toMatchObject({ class: "rate_limited", retryAfterMs: 7000 });
    expect(await mk(async () => res(429, {}, { "retry-after": "999999" })).createMessage(IDS.channel, {}, "n")).toMatchObject({ retryAfterMs: 15 * 60_000 });
  });
  it.each([[500, "server"], [502, "server"], [503, "server"], [401, "auth"], [403, "auth"], [400, "client"], [404, "client"]] as const)("HTTP %s -> %s", async (status, cls) => {
    expect(await mk(async () => res(status)).createMessage(IDS.channel, {}, "n")).toMatchObject({ ok: false, class: cls, status });
  });
  it("timeouts and network errors are classified, never thrown", async () => {
    expect(await mk(hanging).createMessage(IDS.channel, {}, "n")).toEqual({ ok: false, class: "timeout" });
    expect(await mk(async () => { throw new TypeError("fetch failed"); }).createMessage(IDS.channel, {}, "n")).toEqual({ ok: false, class: "network" });
  });
  it("refuses malformed ids locally without any network call (no path injection)", async () => {
    let called = 0; const c = mk(async () => { called++; return res(200, {}); });
    expect(await c.createMessage("../../users/@me", {}, "n")).toMatchObject({ ok: false, class: "client" });
    expect(await c.editMessage(IDS.channel, "1/../2", {})).toMatchObject({ ok: false, class: "client" });
    expect(await c.editOriginalResponse(IDS.app, "bad token with spaces", {})).toMatchObject({ ok: false, class: "client" });
    expect(called).toBe(0);
  });
  it("interaction follow-up edits never send the bot token", async () => {
    let headers: Record<string, string> = {};
    await mk(async (_u, i) => { headers = i!.headers as Record<string, string>; return res(200, {}); }).editOriginalResponse(IDS.app, "T".repeat(40), { content: "x" });
    expect(headers.authorization).toBeUndefined();
  });
});

describe("HttpHealthProvider (protected reporting endpoint client)", () => {
  const SECRET = "s".repeat(40);
  const mk = (fetchFn: F, timeoutMs = 25) => new HttpHealthProvider({ url: "https://reports.example/functions/v1/ops-health", secret: SECRET, fetchFn, now: () => T0, timeoutMs });
  it("signs GET requests with HMAC-SHA256 over timestamp, method and path; the secret itself is never sent", async () => {
    let headers: Record<string, string> = {}; let url = "";
    await mk(async (u, i) => { url = String(u); headers = i!.headers as Record<string, string>; return res(200, healthySnapshot(T0)); }).fetchSnapshot();
    const ts = Math.floor(T0 / 1000);
    const expected = createHmac("sha256", SECRET).update(`${ts}\nGET\n/functions/v1/ops-health`).digest("hex");
    expect(headers["x-azerdex-ops-signature"]).toBe(expected);
    expect(headers["x-azerdex-ops-timestamp"]).toBe(String(ts));
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    expect(url).toBe("https://reports.example/functions/v1/ops-health");
    expect(await signRequest(SECRET, "GET", "/functions/v1/ops-health", ts)).toBe(expected);
  });
  it("returns the validated snapshot on 200", async () => {
    const r = await mk(async () => res(200, healthySnapshot(T0))).fetchSnapshot();
    expect(r.ok).toBe(true);
  });
  it.each([[401, "auth"], [403, "auth"], [429, "rate_limited"], [500, "server"], [503, "server"], [404, "bad_response"], [302, "bad_response"]] as const)("HTTP %s -> %s", async (status, failure) => {
    expect(await mk(async () => res(status, {}, status === 429 ? { "retry-after": "3" } : {})).fetchSnapshot()).toMatchObject({ ok: false, failure, httpStatus: status });
  });
  it("429 carries a bounded retryAfterMs", async () => {
    expect(await mk(async () => res(429, {}, { "retry-after": "3" })).fetchSnapshot()).toMatchObject({ retryAfterMs: 3000 });
    expect(await mk(async () => res(429, {}, { "retry-after": "86400" })).fetchSnapshot()).toMatchObject({ retryAfterMs: 60_000 });
  });
  it("contract violations, wrong content type, oversized and non-JSON bodies are rejected", async () => {
    expect(await mk(async () => res(200, { ...healthySnapshot(T0), extra: 1 })).fetchSnapshot()).toMatchObject({ failure: "contract" });
    expect(await mk(async () => res(200, "{not json")).fetchSnapshot()).toMatchObject({ failure: "contract" });
    expect(await mk(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })).fetchSnapshot()).toMatchObject({ failure: "bad_response" });
    expect(await mk(async () => res(200, "x".repeat(300_000))).fetchSnapshot()).toMatchObject({ failure: "bad_response" });
  });
  it("timeouts and network errors are classified", async () => {
    expect(await mk(hanging).fetchSnapshot()).toEqual({ ok: false, failure: "timeout" });
    expect(await mk(async () => { throw new TypeError("fetch failed"); }).fetchSnapshot()).toEqual({ ok: false, failure: "network" });
  });
});

describe("bounded retry policy", () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  it("retries transient failures up to the attempt limit with exponential backoff", async () => {
    sleeps.length = 0;
    const p = new MockHealthProvider({ ok: false, failure: "server", httpStatus: 500 });
    const { attempts, result } = await fetchWithRetry(p, undefined, sleep);
    expect(attempts).toBe(3); expect(result.ok).toBe(false); expect(sleeps).toEqual([500, 1000]);
  });
  it("never retries authentication or contract failures", async () => {
    for (const failure of ["auth", "contract", "stale", "bad_response"] as const) {
      const p = new MockHealthProvider({ ok: false, failure }); expect((await fetchWithRetry(p, undefined, sleep)).attempts).toBe(1);
    }
  });
  it("stops retrying as soon as a call succeeds; Retry-After is honoured but capped by the policy", async () => {
    sleeps.length = 0;
    const p = new MockHealthProvider(ok(healthySnapshot(T0))).enqueue({ ok: false, failure: "rate_limited", httpStatus: 429, retryAfterMs: 60_000 });
    const { attempts, result } = await fetchWithRetry(p, undefined, sleep);
    expect(attempts).toBe(2); expect(result.ok).toBe(true); expect(sleeps).toEqual([5000]);
  });
  it("the total sleep budget bounds a cron invocation", async () => {
    sleeps.length = 0;
    const p = new MockHealthProvider({ ok: false, failure: "rate_limited", retryAfterMs: 60_000 });
    const { attempts } = await fetchWithRetry(p, { maxAttempts: 10, baseDelayMs: 1000, maxDelayMs: 5000, budgetMs: 8000 }, sleep);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(8000); expect(attempts).toBeLessThan(10);
  });
});

describe("heartbeat and fallback adapters", () => {
  it("pings success, /fail and /log on the configured URL with a fixed-vocabulary body only", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const hb = new HealthchecksHeartbeat("https://hc.example/ping/uuid-canary-0001", async (u, i) => { seen.push({ url: String(u), body: String(i!.body) }); return res(200, "OK"); });
    await hb.success("ok"); await hb.fail("cycle_error"); await hb.log("supabase_degraded");
    expect(seen).toEqual([
      { url: "https://hc.example/ping/uuid-canary-0001", body: "ok" },
      { url: "https://hc.example/ping/uuid-canary-0001/fail", body: "cycle_error" },
      { url: "https://hc.example/ping/uuid-canary-0001/log", body: "supabase_degraded" },
    ]);
  });
  it("a heartbeat or fallback outage returns false and never throws", async () => {
    const hb = new HealthchecksHeartbeat("https://hc.example/ping/x", async () => { throw new TypeError("down"); });
    expect(await hb.success("ok")).toBe(false);
    expect(await new HealthchecksHeartbeat("https://hc.example/ping/x", hanging, 20).fail("cycle_error")).toBe(false);
    expect(await new WebhookFallback("https://fb.example/hook", async () => res(500)).notify("x")).toBe(false);
  });
  it("only https endpoints are accepted", () => {
    expect(() => new HealthchecksHeartbeat("http://hc.example/x")).toThrow();
    expect(() => new WebhookFallback("http://fb.example/x")).toThrow();
  });
  it("the fallback notice is truncated and sent as a JSON {text}", async () => {
    let body = ""; await new WebhookFallback("https://fb.example/hook", async (_u, i) => { body = String(i!.body); return res(200); }).notify("y".repeat(2000));
    expect(JSON.parse(body).text).toHaveLength(500);
  });
});
