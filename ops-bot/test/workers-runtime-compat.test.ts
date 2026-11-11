import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DiscordRestClient } from "../src/discord/client";
import { HttpHealthProvider } from "../src/health/http-provider";
import { HealthchecksHeartbeat, WebhookFallback } from "../src/heartbeat/heartbeat";

/**
 * Found on the first real staging alert: Cloudflare Workers does not implement the Fetch standard's `redirect: "error"` mode. fetch() throws a
 * TypeError before any request is sent, which every client reported as a plain "network" failure (so no alert and no heartbeat ever left the
 * Worker, although the fakes in the other test files passed). The stub below behaves like workerd: it rejects that mode and otherwise returns the
 * scripted response. A redirect must never be followed (the Authorization header would travel with it), so `manual` plus "3xx is a failure" is used.
 */
const ROOT = new URL("..", import.meta.url).pathname;

function workerdFetch(respond: () => Response): { fetchFn: typeof fetch; seen: Array<string | undefined> } {
  const seen: Array<string | undefined> = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    seen.push(init?.redirect);
    if (init?.redirect === "error") throw new TypeError("Invalid redirect value, must be one of \"follow\" or \"manual\" (\"error\" won't be implemented since it does not make sense at the edge; use \"manual\" and check the response status code).");
    return respond();
  }) as typeof fetch;
  return { fetchFn, seen };
}
const redirect = () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } });

describe("clients work under the Workers fetch restrictions", () => {
  it("Discord client: sends (redirect manual) and treats a redirect as a failure, never as delivery", async () => {
    const ok = workerdFetch(() => new Response(JSON.stringify({ id: "1569332852787642460" }), { status: 200 }));
    const r = await new DiscordRestClient({ apiBase: "https://discord.com/api/v10", botToken: "x".repeat(40), fetchFn: ok.fetchFn }).createMessage("1569332852787642459", { content: "t" }, "n1");
    expect(r).toEqual({ ok: true, messageId: "1569332852787642460" });
    expect(ok.seen).toEqual(["manual"]);
    const bad = workerdFetch(redirect);
    const r2 = await new DiscordRestClient({ apiBase: "https://discord.com/api/v10", botToken: "x".repeat(40), fetchFn: bad.fetchFn }).createMessage("1569332852787642459", { content: "t" }, "n1");
    expect(r2.ok).toBe(false);
    expect(r2).toMatchObject({ class: "client", status: 302 });
  });

  it("health provider: requests with redirect manual and reports a redirect as a bad response", async () => {
    const bad = workerdFetch(redirect);
    const r = await new HttpHealthProvider({ url: "https://reports.example/functions/v1/ops-health", secret: "s".repeat(32), fetchFn: bad.fetchFn, now: () => 1_700_000_000_000 }).fetchSnapshot();
    expect(bad.seen).toEqual(["manual"]);
    expect(r).toMatchObject({ ok: false, failure: "bad_response", httpStatus: 302 });
  });

  it("heartbeat and fallback notifier: the ping is actually sent, and a redirect is a failed ping", async () => {
    const good = workerdFetch(() => new Response("OK", { status: 200 }));
    expect(await new HealthchecksHeartbeat("https://hc-ping.com/abc", good.fetchFn).success("ok")).toBe(true);
    expect(await new WebhookFallback("https://ntfy.example/topic", good.fetchFn).notify("t")).toBe(true);
    expect(good.seen).toEqual(["manual", "manual"]);
    const bad = workerdFetch(redirect);
    expect(await new HealthchecksHeartbeat("https://hc-ping.com/abc", bad.fetchFn).success("ok")).toBe(false);
    expect(await new WebhookFallback("https://ntfy.example/topic", bad.fetchFn).notify("t")).toBe(false);
  });

  it("no source file uses the unsupported redirect mode", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    const offenders = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))].filter((f) => /redirect\s*:\s*["']error["']/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
  it("no source file keeps the bare global fetch as a default (it would be called with the wrong receiver)", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    const offenders = walk(join(ROOT, "src")).filter((f) => /\?\?\s*fetch\b(?!\s*\()/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

/**
 * Second defect from the same first real alert: the clients kept the global `fetch` in a property and called it as `this.fetchFn(...)`.
 * workerd throws "Illegal invocation" when fetch runs with any `this` other than the global, again reported as a plain "network" failure.
 * This stub of the GLOBAL fetch has the same restriction; the clients are built WITHOUT an injected fetchFn, like the real Worker does.
 */
describe("default (global) fetch is called with the correct receiver", () => {
  const strictGlobalFetch = function (this: unknown): Promise<Response> {
    if (this !== undefined && this !== globalThis) return Promise.reject(new TypeError("Illegal invocation: function called with incorrect `this` reference."));
    return Promise.resolve(new Response(JSON.stringify({ id: "1569332852787642460" }), { status: 200 }));
  };
  it("Discord client, heartbeat and fallback notifier", async () => {
    vi.stubGlobal("fetch", strictGlobalFetch);
    try {
      const d = await new DiscordRestClient({ apiBase: "https://discord.com/api/v10", botToken: "x".repeat(40) }).createMessage("1569332852787642459", { content: "t" }, "n1");
      expect(d).toEqual({ ok: true, messageId: "1569332852787642460" });
      expect(await new HealthchecksHeartbeat("https://hc-ping.com/abc").success("ok")).toBe(true);
      expect(await new WebhookFallback("https://ntfy.example/topic").notify("t")).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
  it("health provider", async () => {
    vi.stubGlobal("fetch", strictGlobalFetch);
    try {
      const r = await new HttpHealthProvider({ url: "https://reports.example/functions/v1/ops-health", secret: "s".repeat(32), now: () => 1_700_000_000_000 }).fetchSnapshot();
      expect(r).not.toMatchObject({ failure: "network" }); // reaches the response handling (bad content type here), i.e. fetch itself did not throw
    } finally { vi.unstubAllGlobals(); }
  });
});
