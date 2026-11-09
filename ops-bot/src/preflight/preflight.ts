import { ALL, FORBIDDEN_BASE, NEEDED_IN_OWN_CHANNEL, PERM, WARN_BASE, basePermissions, canView, channelPermissions, has, names, type Channel, type Role } from "./permissions";

/**
 * READ-ONLY verification of the Discord side of an environment, run by the owner from a protected shell BEFORE deployment.
 * It performs GET requests only (no message, no permission change, no registration) and never prints the bot token.
 */
export type PreflightEnv = "staging" | "production";
export const EXPECTED_CHANNEL: Record<PreflightEnv, string> = { staging: "ops-testing", production: "ops-alerts" };
export const CONFIRMED_GUILD_ID = "1561649407584370809";
export const OPERATIONS_CATEGORY = "operations";
const PRIVILEGED_INTENT_FLAGS = (1n << 12n) | (1n << 13n) | (1n << 14n) | (1n << 15n) | (1n << 18n) | (1n << 19n);   // presence, guild members, message content (full and limited)

export type CheckStatus = "pass" | "fail" | "warn";
export interface Check { id: string; status: CheckStatus; message: string }
export interface PreflightData {
  env: PreflightEnv; guildId: string; channelId: string; applicationId: string;
  user: { id: string; bot?: boolean } | null;
  application: { id?: string; bot_public?: boolean; bot_require_code_grant?: boolean; flags?: number } | null;
  roles: Role[] | null; memberRoles: string[] | null; channels: Channel[] | null;
  /** HTTP status of GET /users/@me (or why there was none): explains an authentication failure precisely. */
  userStatus?: number | "network";
}

export function authFailure(status: number | "network" | undefined): string {
  if (status === 401) return "Discord rejected the credential (HTTP 401). Typical causes: the value is not the Bot token (the Public Key, the Client Secret or the Application ID was copied instead), the token was reset after it was copied, it has a stray space/newline or a 'Bot ' prefix, or it belongs to another application";
  if (status === 403) return "Discord answered HTTP 403 to the token check: the credential is not allowed to read its own identity (unexpected: re-copy the Bot token)";
  if (status === 429) return "Discord rate-limited the request (HTTP 429): wait a minute and re-run";
  if (status === "network" || status === undefined) return "could not reach discord.com (network, proxy or TLS problem on this machine, or a timeout)";
  return `Discord answered HTTP ${status} to the token check`;
}

export type TokenDiagnosis = { ok: true } | { ok: false; reason: string };
/**
 * OFFLINE sanity check of the token's shape; never prints or returns any part of the token. A Discord bot token is three dot-separated
 * parts and its first part is the base64 of the bot user id (which equals the application id). Advisory only: the API call is the authority.
 */
export function diagnoseToken(token: string, applicationId: string): TokenDiagnosis {
  if (token !== token.trim()) return { ok: false, reason: "the token has leading or trailing whitespace/newline (the script trims it, but re-copy it cleanly)" };
  if (/^bot\s/i.test(token)) return { ok: false, reason: "remove the 'Bot ' prefix: only the raw token is expected" };
  if (/\s/.test(token)) return { ok: false, reason: "the token contains whitespace: it was not copied as a single value" };
  const m = /^([A-Za-z0-9_-]{15,})\.([A-Za-z0-9_-]{4,})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m) return { ok: false, reason: "the value does not have the shape of a bot token (three dot-separated parts). The Public Key, the Client Secret or the Application ID was probably copied instead: use Reset Token on the Bot tab and copy the token shown there" };
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  if (/^\d{17,20}$/.test(decoded) && decoded !== applicationId) return { ok: false, reason: `the token belongs to application ${decoded}, not to DISCORD_APPLICATION_ID ${applicationId}: copy the token of the staging application` };
  return { ok: true };
}

const check = (id: string, ok: boolean, pass: string, fail: string, warn = false): Check => ({ id, status: ok ? "pass" : warn ? "warn" : "fail", message: ok ? pass : fail });

export function evaluatePreflight(d: PreflightData): Check[] {
  const out: Check[] = [];
  out.push(check("guild-is-confirmed-server", d.guildId === CONFIRMED_GUILD_ID, `guild ${CONFIRMED_GUILD_ID}`, `guild id is not the confirmed AzerDex server (${CONFIRMED_GUILD_ID})`));
  if (!d.user) {
    out.push({ id: "discord-auth", status: "fail", message: authFailure(d.userStatus) });
    out.push({ id: "remaining-checks-not-run", status: "fail", message: "the other checks need a working bot token and were NOT run: fix the line above, then re-run" });
    return out;
  }
  out.push(check("bot-identity", d.user.bot === true && d.user.id === d.applicationId, "token belongs to a bot user whose id equals the application id", d.user.bot !== true ? "the credential belongs to a user account, not a bot" : "the token belongs to a different application than DISCORD_APPLICATION_ID"));
  out.push(check("application-private", !!d.application && d.application.bot_public === false && d.application.bot_require_code_grant !== true, "application is not a public bot", "application must have Public Bot OFF and no OAuth2 code grant"));
  const flags = BigInt(d.application?.flags ?? 0);
  out.push(check("no-privileged-intents", d.application !== null && (flags & PRIVILEGED_INTENT_FLAGS) === 0n, "no privileged gateway intents enabled", "privileged gateway intents are enabled (presence, server members or message content): turn them off, this bot does not use the Gateway"));
  if (!d.roles || !d.channels || !d.memberRoles) {
    out.push({ id: "bot-in-guild", status: "fail", message: "the bot is not a member of the guild (or its token cannot read it): invite it first, then re-run" });
    return out;
  }
  out.push({ id: "bot-in-guild", status: "pass", message: "bot is a member of the guild" });

  const base = basePermissions(d.guildId, d.roles, d.memberRoles);
  const forbidden = names(base, FORBIDDEN_BASE);
  out.push(check("no-dangerous-server-permissions", forbidden.length === 0, "no administrative or moderation permission (explicit or inherited)", `bot holds forbidden server-level permissions: ${forbidden.join(", ")}`));
  const warned = names(base, WARN_BASE);
  out.push(check("mention-everyone", warned.length === 0, "bot cannot mention @everyone", `bot inherits ${warned.join(", ")} (from @everyone); acceptable because every payload sets allowed_mentions.parse = [], but remove it if you can`, true));

  const own = d.channels.find((c) => c.id === d.channelId);
  out.push(check("alert-channel-in-guild", !!own, "DISCORD_ALERT_CHANNEL_ID is a channel of this guild", "DISCORD_ALERT_CHANNEL_ID is not a channel of this guild (or the bot cannot see the channel list)"));
  if (!own) return out;
  const expectedName = EXPECTED_CHANNEL[d.env];
  out.push(check("alert-channel-name", own.name === expectedName && own.type === 0, `#${expectedName} (text channel)`, `the ${d.env} alert channel must be the text channel #${expectedName}, found #${own.name} (type ${own.type})`));
  const parent = d.channels.find((c) => c.id === own.parent_id);
  out.push(check("alert-channel-in-operations", !!parent && parent.name.toLowerCase() === OPERATIONS_CATEGORY, "channel sits in the OPERATIONS category", `the channel must be inside a category named OPERATIONS (found ${parent ? `"${parent.name}"` : "no category"})`));

  const botPerms = (c: Channel) => channelPermissions(base, c, d.guildId, d.user!.id, d.memberRoles!);
  const everyonePerms = (c: Channel) => channelPermissions(basePermissions(d.guildId, d.roles!, []), c, d.guildId, null, []);
  const mine = botPerms(own);
  const missing = NEEDED_IN_OWN_CHANNEL.filter((n) => !has(mine, n) || !canView(mine));
  out.push(check("bot-can-post-in-own-channel", missing.length === 0, "bot has View Channel, Send Messages and Embed Links in its channel", `bot is missing in its channel: ${missing.join(", ")}`));
  out.push(check("alert-channel-private", !canView(everyonePerms(own)), "@everyone cannot see the channel", "@everyone can see the alert channel: the OPERATIONS category/channel must deny @everyone View Channel"));
  if (parent) out.push(check("operations-category-private", !canView(everyonePerms(parent)), "@everyone cannot see the OPERATIONS category", "@everyone can see the OPERATIONS category", true));

  // Least privilege: channels the bot can view ONLY because of an explicit grant (not inherited from @everyone) must be exactly its own channel.
  const explicit = d.channels.filter((c) => c.type !== 4 && canView(botPerms(c)) && !canView(everyonePerms(c))).map((c) => c.id);
  const extra = explicit.filter((id) => id !== own.id);
  const extraNames = extra.map((id) => `#${d.channels!.find((c) => c.id === id)?.name ?? id}`);
  out.push(check("explicit-grants-only-own-channel", extra.length === 0 && explicit.includes(own.id), "the only private channel the bot can see is its own", extra.length ? `the bot can see private channels it should not (${extraNames.join(", ")}): remove those grants` : "the bot has no explicit grant on its own channel"));
  out.push({ id: "public-channels-note", status: "pass", message: "like any member, the bot inherits whatever @everyone may do in public channels; the Worker only ever posts to DISCORD_ALERT_CHANNEL_ID" });
  return out;
}

export interface PreflightReport { env: PreflightEnv; ok: boolean; checks: Check[] }
export interface PreflightInput { fetchFn?: typeof fetch; token: string; applicationId: string; guildId: string; channelId: string; env: PreflightEnv; apiBase?: string; timeoutMs?: number }

interface Got<T> { body: T | null; status: number | "network" }
async function get<T>(i: Required<Pick<PreflightInput, "token">> & { fetchFn: typeof fetch; apiBase: string; timeoutMs: number }, path: string): Promise<Got<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), i.timeoutMs);
  try {
    const res = await i.fetchFn(`${i.apiBase}${path}`, { method: "GET", signal: ac.signal, redirect: "error", headers: { authorization: `Bot ${i.token}`, "user-agent": "AzerDexOpsBot-preflight (read-only)" } });
    return { body: res.ok ? ((await res.json()) as T) : null, status: res.status };
  } catch { return { body: null, status: "network" }; } finally { clearTimeout(timer); }
}

/** Five read-only GETs. The token is only used as an Authorization header and is never part of the report. */
export async function runPreflight(input: PreflightInput): Promise<PreflightReport> {
  const ctx = { token: input.token, fetchFn: input.fetchFn ?? fetch, apiBase: input.apiBase ?? "https://discord.com/api/v10", timeoutMs: input.timeoutMs ?? 8000 };
  const userRes = await get<{ id: string; bot?: boolean }>(ctx, "/users/@me");
  const user = userRes.body;
  // Without a valid token the remaining calls would only repeat the same failure: stop after the first one.
  if (!user) {
    const early = evaluatePreflight({ env: input.env, guildId: input.guildId, channelId: input.channelId, applicationId: input.applicationId, user: null, application: null, roles: null, memberRoles: null, channels: null, userStatus: userRes.status });
    return { env: input.env, ok: false, checks: early };
  }
  const application = (await get<PreflightData["application"]>(ctx, "/oauth2/applications/@me")).body;
  const g = encodeURIComponent(input.guildId);
  const roles = (await get<Role[]>(ctx, `/guilds/${g}/roles`)).body;
  const member = (await get<{ roles: string[] }>(ctx, `/guilds/${g}/members/${encodeURIComponent(user.id)}`)).body;
  const channels = (await get<Channel[]>(ctx, `/guilds/${g}/channels`)).body;
  const checks = evaluatePreflight({ env: input.env, guildId: input.guildId, channelId: input.channelId, applicationId: input.applicationId, user, application, roles, memberRoles: member?.roles ?? null, channels, userStatus: userRes.status });
  return { env: input.env, ok: checks.every((c) => c.status !== "fail"), checks };
}
export { ALL, PERM };
