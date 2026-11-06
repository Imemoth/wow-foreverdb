import { webcrypto } from "node:crypto";
import type { Config } from "../../src/config";
import { DEFAULT_TUNING } from "../../src/config";
import type { Clock } from "../../src/db";
import type { DeliveryResult, DiscordClient } from "../../src/discord/client";
import { createLogger, type Logger } from "../../src/util/log";
import { toHex } from "../../src/util/text";

export const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
export class FakeClock implements Clock { constructor(public t = T0) {} now() { return this.t; } advance(ms: number) { this.t += ms; } minutes(m: number) { this.t += m * 60_000; } }

export const IDS = { app: "900000000000000001", guild: "900000000000000002", channel: "900000000000000003", operator: "900000000000000004", operator2: "900000000000000005", stranger: "900000000000000006", otherGuild: "900000000000000007", opRole: "900000000000000008" };

export interface CapturedCall { kind: "create" | "edit" | "original"; channelId?: string; messageId?: string; body: Record<string, unknown>; nonce?: string }
export class FakeDiscord implements DiscordClient {
  calls: CapturedCall[] = [];
  private script: DeliveryResult[] = [];
  private seq = 0;
  enqueue(...r: DeliveryResult[]): this { this.script.push(...r); return this; }
  private next(): DeliveryResult { return this.script.shift() ?? { ok: true, messageId: `91000000000000${String(++this.seq).padStart(4, "0")}` }; }
  async createMessage(channelId: string, body: object, nonce: string) { this.calls.push({ kind: "create", channelId, body: body as never, nonce }); return this.next(); }
  async editMessage(channelId: string, messageId: string, body: object) { this.calls.push({ kind: "edit", channelId, messageId, body: body as never }); return this.next(); }
  async editOriginalResponse(_a: string, _t: string, body: object) { this.calls.push({ kind: "original", body: body as never }); return this.next(); }
  get creates() { return this.calls.filter((c) => c.kind === "create"); }
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    env: "staging",
    discord: { publicKey: "00".repeat(32), botToken: "TEST_BOT_TOKEN_CANARY_aaaaaaaaaaaaaaaaaaaaaaaa", applicationId: IDS.app, alertChannelId: IDS.channel, guildIds: new Set([IDS.guild]), apiBase: "https://discord.com/api/v10" },
    operators: { userIds: new Set([IDS.operator, IDS.operator2]), roleIds: new Set([IDS.opRole]) },
    health: { kind: "mock" }, expectedSourceKeys: ["blizzard-bluepost-us", "blizzard-bluepost-eu", "blizzard-news-us"],
    heartbeatUrl: null, fallbackUrl: null, tuning: { ...DEFAULT_TUNING }, ...over,
  };
}

export interface Keys { publicKeyHex: string; sign(timestamp: string, body: string): Promise<string> }
export async function makeKeys(): Promise<Keys> {
  const kp = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as { publicKey: webcrypto.CryptoKey; privateKey: webcrypto.CryptoKey };
  const raw = await webcrypto.subtle.exportKey("raw", kp.publicKey);
  return { publicKeyHex: toHex(raw), async sign(ts, body) { return toHex(await webcrypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(ts + body))); } };
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger((l) => lines.push(l), () => T0), lines };
}

let seq = 0;
export const nextId = () => `95${String(++seq).padStart(16, "0")}`;
