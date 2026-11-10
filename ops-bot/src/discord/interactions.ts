import { z } from "zod";
import { changes, type Clock, type Db } from "../db";
import type { Config } from "../config";
import type { Logger } from "../util/log";
import { pseudonym } from "../util/log";
import type { DiscordClient } from "./client";
import { handleAckButton, handleCommand, type HandlerCtx, type Json } from "./handlers";
import { ephemeral } from "./messages";
import { verifyDiscordSignature } from "./verify";

export interface InteractionDeps { db: Db; cfg: Config; clock: Clock; discord: DiscordClient; log: Logger; waitUntil: (p: Promise<unknown>) => void }

const Interaction = z.object({
  id: z.string().regex(/^\d{17,20}$/),
  application_id: z.string().regex(/^\d{17,20}$/),
  type: z.number().int(),
  token: z.string().max(300).optional(),
  guild_id: z.string().regex(/^\d{17,20}$/).optional(),
  member: z.object({ user: z.object({ id: z.string().regex(/^\d{17,20}$/) }), roles: z.array(z.string().regex(/^\d{17,20}$/)).max(250).optional() }).optional(),
  user: z.object({ id: z.string().regex(/^\d{17,20}$/) }).optional(),
  data: z.object({ name: z.string().max(32).optional(), custom_id: z.string().max(100).optional(), options: z.array(z.any()).max(10).optional() }).passthrough().optional(),
}).passthrough();

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const reject = (status: number, error: string): Response => json({ error }, status);

export function isAuthorized(cfg: Config, guildId: string | undefined, userId: string | undefined, roles: readonly string[] | undefined): boolean {
  if (!guildId || !userId || !cfg.discord.guildIds.has(guildId)) return false;
  return cfg.operators.userIds.has(userId) || (roles ?? []).some((r) => cfg.operators.roleIds.has(r));
}

async function rateLimited(db: Db, userId: string, now: number, limit: number): Promise<boolean> {
  const row = await db.prepare(
    "insert into rate_limits (key, window_start, count) values (?, ?, 1) on conflict(key) do update set " +
    "count = case when rate_limits.window_start < ? then 1 else rate_limits.count + 1 end, " +
    "window_start = case when rate_limits.window_start < ? then ? else rate_limits.window_start end returning count")
    .bind(`cmd:${userId}`, now, now - 60_000, now - 60_000, now).first<{ count: number }>();
  return (row?.count ?? 1) > limit;
}

/**
 * POST /interactions. Order is security-relevant:
 *  1. bounded raw body  2. signature over the ORIGINAL bytes  3. timestamp freshness  4. only then JSON parsing and schema validation
 *  5. replay check on the interaction id  6. guild + operator authorization  7. per-operator rate limit  8. dispatch under Discord's 3 s deadline.
 */
export async function handleInteractionRequest(req: Request, d: InteractionDeps): Promise<Response> {
  const { cfg, db, clock, log } = d;
  if (req.method !== "POST") return reject(405, "method_not_allowed");
  const sig = req.headers.get("x-signature-ed25519");
  const ts = req.headers.get("x-signature-timestamp");
  if (!sig || !ts || !/^\d{9,12}$/.test(ts)) return reject(401, "invalid_request_signature");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cfg.tuning.maxBodyBytes) return reject(413, "payload_too_large");
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > cfg.tuning.maxBodyBytes) return reject(413, "payload_too_large");

  if (!(await verifyDiscordSignature(cfg.discord.publicKey, ts, raw, sig))) { log.warn("interaction_bad_signature"); return reject(401, "invalid_request_signature"); }
  const now = clock.now();
  if (Math.abs(now / 1000 - Number(ts)) > cfg.tuning.interactionTimestampSkewSeconds) { log.warn("interaction_stale_timestamp"); return reject(401, "invalid_request_signature"); }

  let parsedJson: unknown;
  try { parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw)); } catch { return reject(400, "bad_request"); }
  const parsed = Interaction.safeParse(parsedJson);
  if (!parsed.success) return reject(400, "bad_request");
  const i = parsed.data;
  if (i.application_id !== cfg.discord.applicationId) { log.warn("interaction_wrong_application"); return reject(401, "invalid_request_signature"); }

  const seen = await db.prepare("insert or ignore into seen_interactions (id, seen_at) values (?, ?)").bind(i.id, now).run();
  if (changes(seen) !== 1) { log.warn("interaction_replayed"); return reject(401, "invalid_request_signature"); }

  if (i.type === 1) return json({ type: 1 }); // PING (endpoint validation)

  const userId = i.member?.user.id ?? i.user?.id;
  if (!isAuthorized(cfg, i.guild_id, i.member?.user.id, i.member?.roles)) {
    log.warn("interaction_unauthorized", { user: userId ?? "unknown", guildKnown: i.guild_id ? cfg.discord.guildIds.has(i.guild_id) : false });
    return json(ephemeral("You are not authorized to use AzerDex operations."));
  }
  if (await rateLimited(db, userId!, now, cfg.tuning.rateLimitPerMinute)) {
    log.warn("interaction_rate_limited", { user: userId });
    return json(ephemeral("Too many requests. Wait a minute and try again."));
  }

  const ctx: HandlerCtx = { db, cfg, now, actorId: userId! };
  let work: Promise<Json>;
  if (i.type === 2) work = handleCommand(ctx, i.data as never);
  else if (i.type === 3) work = handleAckButton(ctx, i.data?.custom_id ?? "", cfg.env);
  else return json(ephemeral("Unsupported interaction."));

  const done = work.catch((e) => { log.error("interaction_handler_failed", { errorName: (e as Error).name, user: pseudonym(userId!) }); return ephemeral("Something went wrong. Try again shortly.") as Json; });
  const TIMEOUT = Symbol("timeout");
  const winner = await Promise.race([done, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), cfg.tuning.interactionDeadlineMs))]);
  if (winner !== TIMEOUT) return json(winner);

  // Deadline: acknowledge now (deferred), finish in the background and edit the original response.
  log.warn("interaction_deferred");
  const isComponent = i.type === 3;
  if (i.token) {
    d.waitUntil(done.then(async (result) => {
      const data = (result as { data?: object }).data ?? { content: "Done." };
      await d.discord.editOriginalResponse(cfg.discord.applicationId, i.token!, data);
    }));
  }
  return json(isComponent ? { type: 6 } : { type: 5, data: { flags: 64 } });
}
