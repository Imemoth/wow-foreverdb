import { ConfigError, parseConfig, parseHeartbeatUrl, type Config, type Env } from "./config";
import { systemClock, type Db } from "./db";
import { DiscordRestClient } from "./discord/client";
import { handleInteractionRequest } from "./discord/interactions";
import { HttpHealthProvider } from "./health/http-provider";
import { MockHealthProvider } from "./health/mock-provider";
import { scenarioResult } from "./health/scenarios";
import type { HealthProvider } from "./health/provider";
import { HealthchecksHeartbeat, NoopFallback, NoopHeartbeat, WebhookFallback, type FallbackNotifier, type HeartbeatProvider } from "./heartbeat/heartbeat";
import { getState, runCycle } from "./monitor/cycle";
import { createLogger } from "./util/log";

const log = createLogger();

interface Runtime { cfg: Config; db: Db; provider: HealthProvider; heartbeat: HeartbeatProvider | null; fallback: FallbackNotifier }

function build(env: Env): Runtime {
  const cfg = parseConfig(env); // throws ConfigError with issue codes only
  const provider: HealthProvider = cfg.health.kind === "http"
    ? new HttpHealthProvider({ url: cfg.health.url, secret: cfg.health.secret })
    : new MockHealthProvider(async () => scenarioResult(await getState(env.DB as unknown as Db, "mock_scenario"), Date.now())); // staging only: production refuses the mock provider
  return {
    cfg, db: env.DB as unknown as Db, provider,
    heartbeat: cfg.heartbeatUrl ? new HealthchecksHeartbeat(cfg.heartbeatUrl) : null,
    fallback: cfg.fallbackUrl ? new WebhookFallback(cfg.fallbackUrl) : new NoopFallback(),
  };
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * The Worker factory. The default (production-safe) entry `src/index.ts` passes NO options; only `src/index.staging.ts` passes the staging-only
 * Discord fault injection. wrangler.toml points `[env.staging]` at the staging entry and every other scope at `src/index.ts`, so the injection
 * code is not even in the production bundle (test/bundle-exclusion.test.ts bundles both entries and checks).
 */
export interface WorkerOptions { discordFetch?: (cfg: Config, db: Db) => typeof fetch | undefined }

export function createWorker(opts: WorkerOptions = {}) {
  return {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true }, 200); // liveness only: no state, no configuration echo
    if (url.pathname !== "/interactions") return json({ error: "not_found" }, 404);
    let rt: Runtime;
    try { rt = build(env); } catch (e) {
      log.error("config_invalid", { issues: e instanceof ConfigError ? e.issues : ["unexpected"] });
      return json({ error: "service_unavailable" }, 503);
    }
    const discord = new DiscordRestClient({ apiBase: rt.cfg.discord.apiBase, botToken: rt.cfg.discord.botToken, fetchFn: opts.discordFetch?.(rt.cfg, rt.db) });
    return handleInteractionRequest(request, { db: rt.db, cfg: rt.cfg, clock: systemClock, discord, log, waitUntil: (p) => ctx.waitUntil(p) });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    let rt: Runtime;
    try { rt = build(env); } catch (e) {
      log.error("config_invalid", { issues: e instanceof ConfigError ? e.issues : ["unexpected"] });
      // A misconfigured bot must still be detectable: signal the independent heartbeat if its URL alone is valid.
      const hb = parseHeartbeatUrl(env);
      if (hb) await new HealthchecksHeartbeat(hb).fail("config_error");
      throw e;
    }
    const discord = new DiscordRestClient({ apiBase: rt.cfg.discord.apiBase, botToken: rt.cfg.discord.botToken, fetchFn: opts.discordFetch?.(rt.cfg, rt.db) });
    const heartbeat = rt.heartbeat ?? new NoopHeartbeat();
    ctx.waitUntil(runCycle({ db: rt.db, cfg: rt.cfg, clock: systemClock, provider: rt.provider, discord, heartbeat, fallback: rt.fallback, log }).then(() => undefined));
  },
  };
}

export default createWorker();
