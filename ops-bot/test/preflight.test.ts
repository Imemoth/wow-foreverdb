import { describe, expect, it } from "vitest";
import { PERM, basePermissions, channelPermissions, has, canView, ALL, type Channel, type Role, type Overwrite } from "../src/preflight/permissions";
import { CONFIRMED_GUILD_ID, EXPECTED_CHANNEL, authFailure, diagnoseToken, evaluatePreflight, runPreflight, type PreflightData, type PreflightEnv } from "../src/preflight/preflight";

const G = CONFIRMED_GUILD_ID;
const BOT = "900000000000000100", APP = BOT;
const ROLE_MOD = "900000000000000201", ROLE_BOT = "900000000000000202", ROLE_ADMIN = "900000000000000203";
const CAT_START = "900000000000000301", CAT_STAFF = "900000000000000302", CAT_OPS = "900000000000000303";
const CH_GENERAL = "900000000000000401", CH_STAFF = "900000000000000402", CH_OPS_TEST = "900000000000000403", CH_OPS_ALERTS = "900000000000000404", CH_RULES = "900000000000000405";
const n = (...p: bigint[]) => p.reduce((a, b) => a | b, 0n).toString();
const EVERYONE_PERMS = n(PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES, PERM.EMBED_LINKS, PERM.READ_MESSAGE_HISTORY, PERM.ADD_REACTIONS, PERM.CREATE_INSTANT_INVITE);
const denyView = (id = G): Overwrite => ({ id, type: 0, allow: "0", deny: PERM.VIEW_CHANNEL.toString() });
const memberAllow = (id: string, ...p: bigint[]): Overwrite => ({ id, type: 1, allow: n(...p), deny: "0" });
const ch = (id: string, name: string, type: number, parent: string | null, ows: Overwrite[] = []): Channel => ({ id, name, type, parent_id: parent, permission_overwrites: ows });

function guild(over: { botRoles?: string[]; roles?: Role[]; extra?: Channel[]; opsTest?: Overwrite[]; opsCat?: Overwrite[]; opsTestName?: string; opsTestParent?: string | null } = {}) {
  const roles: Role[] = over.roles ?? [
    { id: G, name: "@everyone", permissions: EVERYONE_PERMS },
    { id: ROLE_MOD, name: "Moderator", permissions: n(PERM.MANAGE_MESSAGES, PERM.KICK_MEMBERS) },
    { id: ROLE_BOT, name: "AzerDex Ops (staging)", permissions: "0", managed: true },
  ];
  const channels: Channel[] = [
    ch(CAT_START, "START HERE", 4, null), ch(CH_RULES, "rules", 0, CAT_START), ch(CH_GENERAL, "general", 0, CAT_START),
    ch(CAT_STAFF, "STAFF ONLY", 4, null, [denyView(), { id: ROLE_MOD, type: 0, allow: PERM.VIEW_CHANNEL.toString(), deny: "0" }]),
    ch(CH_STAFF, "staff-chat", 0, CAT_STAFF, [denyView(), { id: ROLE_MOD, type: 0, allow: PERM.VIEW_CHANNEL.toString(), deny: "0" }]),
    ch(CAT_OPS, "OPERATIONS", 4, null, over.opsCat ?? [denyView()]),
    ch(CH_OPS_TEST, over.opsTestName ?? "ops-testing", 0, over.opsTestParent === undefined ? CAT_OPS : over.opsTestParent, over.opsTest ?? [denyView(), memberAllow(BOT, PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES, PERM.EMBED_LINKS)]),
    ...(over.extra ?? []),
  ];
  return { roles, channels, memberRoles: over.botRoles ?? [ROLE_BOT] };
}
const data = (g: ReturnType<typeof guild>, o: Partial<PreflightData> = {}): PreflightData => ({
  env: "staging", guildId: G, channelId: CH_OPS_TEST, applicationId: APP, user: { id: BOT, bot: true },
  application: { id: APP, bot_public: false, bot_require_code_grant: false, flags: 0 }, roles: g.roles, memberRoles: g.memberRoles, channels: g.channels, ...o,
});
const status = (checks: ReturnType<typeof evaluatePreflight>, id: string) => checks.find((c) => c.id === id)?.status;
const failing = (checks: ReturnType<typeof evaluatePreflight>) => checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("permission arithmetic (Discord's documented order)", () => {
  const roles: Role[] = [{ id: G, name: "@everyone", permissions: EVERYONE_PERMS }, { id: ROLE_MOD, name: "m", permissions: n(PERM.MANAGE_MESSAGES) }, { id: ROLE_ADMIN, name: "a", permissions: n(PERM.ADMINISTRATOR) }];
  it("base permissions combine @everyone and the member's roles; ADMINISTRATOR means everything", () => {
    expect(has(basePermissions(G, roles, [ROLE_MOD]), "MANAGE_MESSAGES")).toBe(true);
    expect(has(basePermissions(G, roles, []), "MANAGE_MESSAGES")).toBe(false);
    expect(basePermissions(G, roles, [ROLE_ADMIN])).toBe(ALL);
  });
  it("overwrites apply in order: @everyone, then roles, then the member (a member allow beats a role deny; deny beats the base)", () => {
    const base = basePermissions(G, roles, [ROLE_MOD]);
    const c = ch("1", "x", 0, null, [{ id: G, type: 0, allow: "0", deny: PERM.SEND_MESSAGES.toString() }, { id: ROLE_MOD, type: 0, allow: "0", deny: PERM.VIEW_CHANNEL.toString() }, memberAllow(BOT, PERM.VIEW_CHANNEL)]);
    const p = channelPermissions(base, c, G, BOT, [ROLE_MOD]);
    expect(has(p, "SEND_MESSAGES")).toBe(false);     // denied for @everyone, never re-allowed
    expect(canView(p)).toBe(true);                   // role deny overridden by the member allow
    expect(canView(channelPermissions(base, c, G, "other", [ROLE_MOD]))).toBe(false);   // without the member allow the role deny wins
  });
  it("a role allow re-opens what @everyone denied, and Administrator ignores every overwrite", () => {
    const c = ch("1", "x", 0, null, [denyView(), { id: ROLE_MOD, type: 0, allow: PERM.VIEW_CHANNEL.toString(), deny: "0" }]);
    expect(canView(channelPermissions(basePermissions(G, roles, [ROLE_MOD]), c, G, BOT, [ROLE_MOD]))).toBe(true);
    expect(canView(channelPermissions(basePermissions(G, roles, []), c, G, BOT, []))).toBe(false);
    expect(canView(channelPermissions(basePermissions(G, roles, [ROLE_ADMIN]), c, G, BOT, [ROLE_ADMIN]))).toBe(true);
  });
});

describe("preflight: a correct staging configuration (modelled on the AzerDex server layout)", () => {
  it("passes every required check; the bot is limited to #ops-testing among private channels", () => {
    const checks = evaluatePreflight(data(guild()));
    expect(failing(checks)).toEqual([]);
    expect(status(checks, "explicit-grants-only-own-channel")).toBe("pass");
    expect(status(checks, "alert-channel-private")).toBe("pass");
  });
  it("the staging and production expectations are different channels", () => {
    expect(EXPECTED_CHANNEL).toEqual({ staging: "ops-testing", production: "ops-alerts" });
    const prod = evaluatePreflight(data(guild(), { env: "production" as PreflightEnv }));
    expect(failing(prod)).toContain("alert-channel-name");               // a staging channel is not acceptable for production
  });
  it("inherited @everyone permissions in PUBLIC channels are expected and do not fail the check", () => {
    const g = guild();
    const checks = evaluatePreflight(data(g));
    expect(failing(checks)).toEqual([]);
    expect(checks.find((c) => c.id === "public-channels-note")!.message).toMatch(/inherits whatever @everyone/);
  });
});

describe("preflight: every misconfiguration is caught", () => {
  it("Administrator (via a role) fails, as does any forbidden server-level permission", () => {
    const g = guild({ roles: [{ id: G, name: "@everyone", permissions: EVERYONE_PERMS }, { id: ROLE_BOT, name: "bot", permissions: n(PERM.ADMINISTRATOR), managed: true }] });
    expect(failing(evaluatePreflight(data(g)))).toContain("no-dangerous-server-permissions");
    const g2 = guild({ roles: [{ id: G, name: "@everyone", permissions: EVERYONE_PERMS }, { id: ROLE_BOT, name: "bot", permissions: n(PERM.MANAGE_MESSAGES, PERM.MANAGE_CHANNELS), managed: true }] });
    expect(failing(evaluatePreflight(data(g2)))).toContain("no-dangerous-server-permissions");
  });
  it("a bot that was also given the Moderator role can see STAFF ONLY: explicit-grant check fails and names the channel", () => {
    const g = guild({ botRoles: [ROLE_BOT, ROLE_MOD] });
    const checks = evaluatePreflight(data(g));
    expect(failing(checks)).toContain("explicit-grants-only-own-channel");
    expect(checks.find((c) => c.id === "explicit-grants-only-own-channel")!.message).toContain("#staff-chat");
  });
  it("the staging bot being able to see the production channel fails (strict environment separation)", () => {
    const alerts = ch(CH_OPS_ALERTS, "ops-alerts", 0, CAT_OPS, [denyView(), memberAllow(BOT, PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES, PERM.EMBED_LINKS)]);
    const checks = evaluatePreflight(data(guild({ extra: [alerts] })));
    expect(failing(checks)).toContain("explicit-grants-only-own-channel");
    expect(checks.find((c) => c.id === "explicit-grants-only-own-channel")!.message).toContain("#ops-alerts");
  });
  it("missing Send Messages or Embed Links in the bot's own channel fails", () => {
    for (const grant of [[PERM.VIEW_CHANNEL, PERM.EMBED_LINKS], [PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES], [PERM.SEND_MESSAGES, PERM.EMBED_LINKS]]) {
      // a realistic locked channel: @everyone is denied View, Send and Embed there, so only the bot's explicit grant can provide them
      const locked: Overwrite = { id: G, type: 0, allow: "0", deny: n(PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES, PERM.EMBED_LINKS) };
      const g = guild({ opsTest: [locked, memberAllow(BOT, ...grant)] });
      expect(failing(evaluatePreflight(data(g))), grant.join()).toContain("bot-can-post-in-own-channel");
    }
  });
  it("a channel (or category) that @everyone can see fails: it must be private", () => {
    const open = guild({ opsTest: [memberAllow(BOT, PERM.VIEW_CHANNEL, PERM.SEND_MESSAGES, PERM.EMBED_LINKS)], opsCat: [] });
    const checks = evaluatePreflight(data(open));
    expect(failing(checks)).toContain("alert-channel-private");
    expect(status(checks, "operations-category-private")).toBe("warn");
  });
  it("a channel outside the OPERATIONS category, or with the wrong name/type, fails", () => {
    expect(failing(evaluatePreflight(data(guild({ opsTestParent: CAT_START }))))).toContain("alert-channel-in-operations");
    expect(failing(evaluatePreflight(data(guild({ opsTestParent: null }))))).toContain("alert-channel-in-operations");
    expect(failing(evaluatePreflight(data(guild({ opsTestName: "ops-test" }))))).toContain("alert-channel-name");
  });
  it("an alert channel id that is not in the guild fails; a missing bot membership fails closed", () => {
    expect(failing(evaluatePreflight(data(guild(), { channelId: "900000000000009999" })))).toContain("alert-channel-in-guild");
    const g = guild();
    expect(failing(evaluatePreflight(data(g, { roles: null, channels: null, memberRoles: null })))).toContain("bot-in-guild");
  });
  it("a public bot, a code-grant requirement, or any privileged gateway intent fails", () => {
    expect(failing(evaluatePreflight(data(guild(), { application: { id: APP, bot_public: true, flags: 0 } })))).toContain("application-private");
    expect(failing(evaluatePreflight(data(guild(), { application: { id: APP, bot_public: false, bot_require_code_grant: true, flags: 0 } })))).toContain("application-private");
    for (const bit of [12, 13, 14, 15, 18, 19]) expect(failing(evaluatePreflight(data(guild(), { application: { id: APP, bot_public: false, flags: 2 ** bit } }))), `flag ${bit}`).toContain("no-privileged-intents");
  });
  it("a token for another application, a non-bot user, or a wrong guild fails", () => {
    expect(failing(evaluatePreflight(data(guild(), { applicationId: "900000000000000999" })))).toContain("bot-identity");
    expect(failing(evaluatePreflight(data(guild(), { user: { id: BOT, bot: false } })))).toContain("bot-identity");
    expect(failing(evaluatePreflight(data(guild(), { guildId: "900000000000000001" })))).toContain("guild-is-confirmed-server");
  });
  it("@everyone Mention Everyone is only a warning (allowed_mentions neutralises it)", () => {
    const g = guild({ roles: [{ id: G, name: "@everyone", permissions: n(BigInt(EVERYONE_PERMS), PERM.MENTION_EVERYONE) }, { id: ROLE_BOT, name: "bot", permissions: "0", managed: true }] });
    const checks = evaluatePreflight(data(g));
    expect(status(checks, "mention-everyone")).toBe("warn");
    expect(failing(checks)).toEqual([]);
  });
});

describe("runPreflight performs read-only requests and never leaks the token", () => {
  const TOKEN = "PREFLIGHT_TOKEN_CANARY_0123456789abcdefghij";
  const g = guild();
  const routes: Record<string, unknown> = {
    "/users/@me": { id: BOT, bot: true }, "/oauth2/applications/@me": { id: APP, bot_public: false, bot_require_code_grant: false, flags: 0 },
    [`/guilds/${G}/roles`]: g.roles, [`/guilds/${G}/members/${BOT}`]: { roles: g.memberRoles }, [`/guilds/${G}/channels`]: g.channels,
  };
  const fake = (calls: Array<{ method?: string; path: string; auth?: string }>, override: Record<string, number> = {}): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace("/api/v10", "");
    calls.push({ method: init?.method, path, auth: (init?.headers as Record<string, string>)?.authorization });
    if (override[path]) return new Response("{}", { status: override[path] });
    return routes[path] === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const input = { token: TOKEN, applicationId: APP, guildId: G, channelId: CH_OPS_TEST, env: "staging" as PreflightEnv };

  it("uses GET only, exactly the five documented endpoints, and a good configuration is READY", async () => {
    const calls: Array<{ method?: string; path: string; auth?: string }> = [];
    const report = await runPreflight({ ...input, fetchFn: fake(calls) });
    expect(report.ok).toBe(true);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(calls.map((c) => c.path).sort()).toEqual(["/guilds/" + G + "/channels", "/guilds/" + G + "/members/" + BOT, "/guilds/" + G + "/roles", "/oauth2/applications/@me", "/users/@me"].sort());
    expect(calls.every((c) => c.auth === `Bot ${TOKEN}`)).toBe(true);
  });
  it("the report never contains the token", async () => {
    const report = await runPreflight({ ...input, fetchFn: fake([]) });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    const bad = await runPreflight({ ...input, fetchFn: fake([], { "/users/@me": 401 }) });
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
  });
  it("an invalid token (401), a bot that is not in the guild (403/404) or an unreachable API all fail closed", async () => {
    expect((await runPreflight({ ...input, fetchFn: fake([], { "/users/@me": 401 }) })).ok).toBe(false);
    expect((await runPreflight({ ...input, fetchFn: fake([], { [`/guilds/${G}/roles`]: 403, [`/guilds/${G}/channels`]: 403 }) })).ok).toBe(false);
    const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect((await runPreflight({ ...input, fetchFn: down })).ok).toBe(false);
  });
});

describe("authentication failures are explained precisely (owner-facing diagnostics)", () => {
  const TOKEN_B64 = Buffer.from(APP).toString("base64").replace(/=+$/, "");
  const GOOD_TOKEN = `${TOKEN_B64}.GhIjKl.${"x".repeat(27)}`;                   // synthetic: same shape as a real bot token, not a credential
  const none = (userStatus: PreflightData["userStatus"]) => evaluatePreflight(data(guild(), { user: null, application: null, roles: null, memberRoles: null, channels: null, ...(userStatus === undefined ? {} : { userStatus }) }));

  it("a rejected credential reports ONE precise failure with the HTTP status instead of four cascading ones", () => {
    const checks = none(401);
    expect(checks.map((c) => c.id)).toEqual(["guild-is-confirmed-server", "discord-auth", "remaining-checks-not-run"]);
    const auth = checks.find((c) => c.id === "discord-auth")!;
    expect(auth.status).toBe("fail");
    expect(auth.message).toContain("HTTP 401");
    for (const hint of ["Public Key", "Client Secret", "reset", "Bot "]) expect(auth.message).toContain(hint);
    expect(failing(checks)).toContain("remaining-checks-not-run");     // the run can never be READY after an auth failure
  });
  it("other statuses and network problems are told apart", () => {
    expect(authFailure(403)).toContain("HTTP 403");
    expect(authFailure(429)).toContain("rate-limited");
    expect(authFailure("network")).toMatch(/could not reach discord\.com/);
    expect(authFailure(undefined)).toMatch(/could not reach discord\.com/);
    expect(authFailure(500)).toContain("HTTP 500");
  });
  it("runPreflight stops after the first failed call (no cascade of requests with a bad credential) and never echoes the token", async () => {
    const calls: string[] = [];
    const TOKEN = "NOT_A_TOKEN_CANARY_0123456789abcdefghij";
    const f = (async (url: string | URL | Request) => { calls.push(new URL(String(url)).pathname); return new Response("{}", { status: 401 }); }) as typeof fetch;
    const report = await runPreflight({ token: TOKEN, applicationId: APP, guildId: G, channelId: CH_OPS_TEST, env: "staging", fetchFn: f });
    expect(report.ok).toBe(false);
    expect(calls).toEqual(["/api/v10/users/@me"]);
    expect(report.checks.find((c) => c.id === "discord-auth")!.message).toContain("401");
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
  it("a network failure is reported as such, not as a bad token", async () => {
    const down = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    const report = await runPreflight({ token: "T".repeat(40), applicationId: APP, guildId: G, channelId: CH_OPS_TEST, env: "staging", fetchFn: down });
    expect(report.checks.find((c) => c.id === "discord-auth")!.message).toMatch(/could not reach discord\.com/);
  });
  it("a user-account credential or another application's token is told apart from an invalid token", () => {
    const asUser = evaluatePreflight(data(guild(), { user: { id: BOT, bot: false } }));
    expect(asUser.find((c) => c.id === "bot-identity")!.message).toMatch(/user account, not a bot/);
    const other = evaluatePreflight(data(guild(), { user: { id: "900000000000000999", bot: true } }));
    expect(other.find((c) => c.id === "bot-identity")!.message).toMatch(/different application/);
  });

  describe("diagnoseToken: offline, advisory, never reveals the token", () => {
    it("accepts a well-formed token of the right application", () => expect(diagnoseToken(GOOD_TOKEN, APP)).toEqual({ ok: true }));
    it("flags whitespace, a 'Bot ' prefix and values of the wrong kind (Public Key, Client Secret, Application ID)", () => {
      expect(diagnoseToken(`${GOOD_TOKEN}\n`, APP)).toMatchObject({ ok: false, reason: expect.stringContaining("whitespace") });
      expect(diagnoseToken(`Bot ${GOOD_TOKEN}`, APP)).toMatchObject({ ok: false, reason: expect.stringContaining("'Bot ' prefix") });
      expect(diagnoseToken(`${GOOD_TOKEN.slice(0, 20)} ${GOOD_TOKEN.slice(20)}`, APP)).toMatchObject({ ok: false, reason: expect.stringContaining("contains whitespace") });
      const publicKey = "f77e67748d4a15411db0c5da9951c6aa1e31ea1fac6c678996802914c6915a0c";
      const clientSecret = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
      for (const wrong of [publicKey, clientSecret, APP]) {
        const d = diagnoseToken(wrong, APP);
        expect(d.ok).toBe(false);
        if (!d.ok) expect(d.reason).toMatch(/shape of a bot token/);
      }
    });
    it("detects a token that belongs to another application and names that (non-secret) application id", () => {
      const other = `${Buffer.from("900000000000000999").toString("base64").replace(/=+$/, "")}.GhIjKl.${"y".repeat(27)}`;
      const d = diagnoseToken(other, APP);
      expect(d.ok).toBe(false);
      if (!d.ok) { expect(d.reason).toContain("900000000000000999"); expect(d.reason).toContain(APP); }
    });
    it("no diagnosis ever contains any part of the token", () => {
      const tokens = [GOOD_TOKEN, `${GOOD_TOKEN} `, `Bot ${GOOD_TOKEN}`, "f77e67748d4a15411db0c5da9951c6aa1e31ea1fac6c678996802914c6915a0c", "Secret_Value_ABCDEFGHIJ0123456789", `${Buffer.from("900000000000000999").toString("base64")}.abcdef.${"z".repeat(30)}`];
      for (const t of tokens) {
        const d = diagnoseToken(t, APP);
        if (!d.ok) for (const chunk of [t.slice(0, 12), t.slice(-12)]) expect(d.reason).not.toContain(chunk.trim());
      }
    });
  });
});
