import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ephemeral, ephemeralLines, renderIncidentMessage } from "../src/discord/messages";
import { redact, redactString } from "../src/util/log";
import { sanitizeText } from "../src/util/text";
import { findDiscordWebhookUrls, isDiscordHost } from "./helpers/secret-scan";

/** Regression tests for the two CodeQL findings on PR #174 (js/polynomial-redos in messages.ts, js/regex/missing-regexp-anchor in the test detector). */

const BUDGET_MS = 250;
const timed = (f: () => unknown): number => { const t = performance.now(); f(); return performance.now() - t; };

describe("CodeQL js/polynomial-redos: ephemeralLines (messages.ts)", () => {
  it("a 200,000-character whitespace run followed by text is processed in linear time (was quadratic: 60k chars took ~3 s)", () => {
    for (const ws of ["\t", " ", " ", " "]) {
      const line = `a${ws.repeat(200_000)}b`;
      expect(timed(() => ephemeralLines([line, line]))).toBeLessThan(BUDGET_MS);
    }
  });
  it("still trims trailing whitespace of each line, keeps interior whitespace, and bounds the content to 1900 characters", () => {
    const r = ephemeralLines(["first  \t ", "second line  ", "  indented", "  "]);
    expect(r.data.content).toBe("first\nsecond line\n  indented\n");
    expect(ephemeralLines(["x".repeat(5000)]).data.content).toHaveLength(1900);
    expect(r.data.flags).toBe(64);
    expect(r.data.allowed_mentions).toEqual({ parse: [] });
  });
  it("trailing-whitespace semantics are identical to the removed regex for every whitespace character class JavaScript defines", () => {
    const chars = ["\t", "\n", "\v", "\f", "\r", " ", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"];
    for (const c of chars) for (const body of ["x", "x y", ""]) {
      const input = `${body}${c}${c}`;
      expect(ephemeralLines([input]).data.content).toBe(input.replace(/\s+$/g, "")); // legacy behaviour, evaluated on SMALL inputs only
    }
  });
});

describe("adversarial-input budget for every text-processing helper (same defect class)", () => {
  const N = 60_000;
  const inputs: Record<string, string> = {
    "tab run then text": `a${"\t".repeat(N)}b`,
    "space run then text": `${" ".repeat(N)}x`,
    "hyphen run": `a${"-".repeat(N)}`,
    "alternating word/hyphen": "a-".repeat(N / 2),
    "hex run ending in non-hex": `${"0".repeat(N)}g`,
    "mention openers": "<@".repeat(N / 2),
    "bot prefixes": "Bot ".repeat(N / 4),
    "bearer prefixes": "Bearer ".repeat(N / 7),
    "webhook url repeats": "https://discord.com/api/webhooks/".repeat(N / 33),
    "very long token-like word": "A".repeat(N) + "!",
  };
  it.each(Object.entries(inputs))("%s", (_name, s) => {
    expect(timed(() => sanitizeText(s, 200))).toBeLessThan(BUDGET_MS);
    expect(timed(() => redactString(s))).toBeLessThan(BUDGET_MS);
    expect(timed(() => redact({ note: s, nested: { note: s } }))).toBeLessThan(BUDGET_MS);
    expect(timed(() => ephemeral(s))).toBeLessThan(BUDGET_MS);
    expect(timed(() => ephemeralLines([s]))).toBeLessThan(BUDGET_MS);
    const inc = { id: "INC-261106-ABCD", component: s, status: "OPEN", severity: "CRITICAL", reason_code: s, summary: s, context: JSON.stringify({ cause: s }), first_seen_at: 0, last_seen_at: 0, occurrences: 1, healthy_streak: 0, update_count: 0, last_notified_at: null, reminder_count: 0, ack_by: null, ack_at: null, ack_note: null, resolved_at: null, alert_message_id: null, alert_channel_id: null, updated_at: 0 } as const;
    expect(timed(() => renderIncidentMessage(inc as never, "OPEN", "staging"))).toBeLessThan(BUDGET_MS);
  });
  it("no source file reintroduces a whitespace-run-before-anchor regex (`\\s+$`, `\\s*$`), the exact shape CodeQL flagged", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const root = new URL("../src", import.meta.url).pathname;
    for (const p of walk(root)) expect(readFileSync(p, "utf8"), p).not.toMatch(/\\s[+*]\$/);
  });
});

describe("CodeQL js/regex/missing-regexp-anchor: parsed-URL credential detector", () => {
  const token = "A1b2C3d4E5f6G7h8I9j0K1l2M3";
  const real = (host: string, scheme = "https") => `${scheme}://${host}/api/webhooks/123456789012345678/${token}`;
  it("detects Discord webhook URLs on discord.com and discordapp.com, including subdomains, ports, versions, http and upper case", () => {
    for (const u of [real("discord.com"), real("discordapp.com"), real("canary.discord.com"), real("PTB.Discord.COM"), real("discord.com:443"), real("discord.com", "http"), `https://discord.com/api/v10/webhooks/123456789012345678/${token}`]) {
      expect(findDiscordWebhookUrls(`prefix ${u} suffix`), u).toHaveLength(1);
    }
  });
  it("matches by exact hostname, not by substring: look-alike hosts and userinfo tricks are not Discord URLs", () => {
    for (const host of ["notdiscord.com", "discord.com.evil.example", "evil.example", "discordxcom"]) expect(findDiscordWebhookUrls(real(host)), host).toEqual([]);
    expect(isDiscordHost("discord.com.evil.example")).toBe(false);
    expect(isDiscordHost("evil-discord.com")).toBe(false);
    expect(isDiscordHost("cdn.discordapp.com")).toBe(true);
    // userinfo can make a URL look like Discord at the start while the real host is elsewhere
    expect(findDiscordWebhookUrls(`https://discord.com@evil.example/api/webhooks/123456789012345678/${token}`)).toEqual([]);
  });
  it("requires the webhook path shape and a long token; plain Discord URLs are fine", () => {
    for (const u of ["https://discord.com/api/webhooks/123456789012345678", "https://discord.com/api/webhooks/123/short", "https://discord.com/channels/1/2", "https://discord.com/api/v10/channels/1/messages"]) expect(findDiscordWebhookUrls(u), u).toEqual([]);
  });
  it("finds every occurrence, ignores unparsable candidates, and is linear on adversarial input", () => {
    const text = `${real("discord.com")}\nnoise http://[::1 ${real("canary.discord.com")}`;
    expect(findDiscordWebhookUrls(text)).toHaveLength(2);
    expect(timed(() => findDiscordWebhookUrls("https://".repeat(30_000) + "a".repeat(30_000)))).toBeLessThan(BUDGET_MS);
  });
});
