import type { Config } from "../../src/config";
import { runCycle, type CycleDeps, type CycleResult } from "../../src/monitor/cycle";
import { MockHealthProvider, healthySnapshot, ok } from "../../src/health/mock-provider";
import { RecordingFallback, RecordingHeartbeat } from "../../src/heartbeat/heartbeat";
import { handleInteractionRequest } from "../../src/discord/interactions";
import type { Db, DbStatement } from "../../src/db";
import { newDb, type TestDb } from "./d1";
import { FakeClock, FakeDiscord, IDS, captureLog, makeKeys, nextId, testConfig, type Keys } from "./fakes";

export interface Harness {
  db: TestDb; clock: FakeClock; discord: FakeDiscord; provider: MockHealthProvider; heartbeat: RecordingHeartbeat; fallback: RecordingFallback;
  cfg: Config; keys: Keys; lines: string[]; deps: CycleDeps;
  cycle(): Promise<CycleResult>;
  interact(body: object, o?: { ts?: string; sig?: string; skipSign?: boolean; raw?: string; slowMs?: number }): Promise<Response>;
  bg: Promise<unknown>[];
}

export async function harness(over: Partial<Config> = {}): Promise<Harness> {
  const keys = await makeKeys();
  const cfg = testConfig({ discord: { ...testConfig().discord, publicKey: keys.publicKeyHex }, ...over });
  const db = newDb();
  const clock = new FakeClock();
  const discord = new FakeDiscord();
  const provider = new MockHealthProvider(() => ok(healthySnapshot(clock.now())));
  const heartbeat = new RecordingHeartbeat();
  const fallback = new RecordingFallback();
  const { log, lines } = captureLog();
  const bg: Promise<unknown>[] = [];
  const deps: CycleDeps = { db, cfg, clock, provider, discord, heartbeat, fallback, log, sleep: async () => undefined };
  return {
    db, clock, discord, provider, heartbeat, fallback, cfg, keys, lines, deps, bg,
    cycle: () => runCycle(deps),
    async interact(body, o = {}) {
      const raw = o.raw ?? JSON.stringify(body);
      const ts = o.ts ?? String(Math.floor(clock.now() / 1000));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (!o.skipSign) { headers["x-signature-ed25519"] = o.sig ?? (await keys.sign(ts, raw)); headers["x-signature-timestamp"] = ts; }
      const idb = o.slowMs ? slow(db, o.slowMs) : db;
      return handleInteractionRequest(new Request("https://bot.example/interactions", { method: "POST", headers, body: raw }), { db: idb, cfg, clock, discord, log, waitUntil: (p) => { bg.push(p); } });
    },
  };
}

export interface Who { userId?: string; guildId?: string; roles?: string[]; dm?: boolean }
export function command(sub: string, options: Array<{ name: string; type: number; value: unknown }> = [], who: Who = {}) {
  const userId = who.userId ?? IDS.operator;
  return {
    id: nextId(), application_id: IDS.app, type: 2, token: "T".repeat(40),
    ...(who.dm ? { user: { id: userId } } : { guild_id: who.guildId ?? IDS.guild, member: { user: { id: userId }, roles: who.roles ?? [] } }),
    data: { name: "azerdex", options: [{ type: 1, name: sub, options }] },
  };
}
export function button(customId: string, who: Who = {}) {
  const userId = who.userId ?? IDS.operator;
  return { id: nextId(), application_id: IDS.app, type: 3, token: "T".repeat(40), guild_id: who.guildId ?? IDS.guild, member: { user: { id: userId }, roles: who.roles ?? [] }, data: { custom_id: customId, component_type: 2 } };
}
export const str = (name: string, value: string) => ({ name, type: 3, value });
export const int = (name: string, value: number) => ({ name, type: 4, value });
export const text = async (r: Response): Promise<string> => JSON.stringify(await r.json());

/** Wraps a Db so reads are artificially slow: used to exercise the Discord 3-second deadline path. */
export function slow(inner: Db, ms: number): Db {
  const wait = () => new Promise((r) => setTimeout(r, ms));
  const wrap = (st: DbStatement): DbStatement => ({
    bind: (...v) => wrap(st.bind(...v)),
    first: async () => { await wait(); return st.first(); },
    all: async () => { await wait(); return st.all(); },
    run: () => st.run(),
  } as DbStatement);
  return { prepare: (sql) => wrap(inner.prepare(sql)), batch: (s) => inner.batch(s) };
}
