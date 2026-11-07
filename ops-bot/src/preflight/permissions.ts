/**
 * Discord permission arithmetic, following Discord's documented algorithm:
 *   base = @everyone role | the member's roles (ADMINISTRATOR short-circuits to everything);
 *   channel: apply the @everyone overwrite, then the combined role overwrites, then the member overwrite.
 * Pure functions (no I/O) so they can be tested exhaustively.
 */
export const PERM = {
  CREATE_INSTANT_INVITE: 1n << 0n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n, ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n, ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n,
  VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, MANAGE_MESSAGES: 1n << 13n, EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n, READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n,
  MANAGE_ROLES: 1n << 28n, MANAGE_WEBHOOKS: 1n << 29n, MANAGE_THREADS: 1n << 34n, MODERATE_MEMBERS: 1n << 40n,
} as const;
export type PermName = keyof typeof PERM;
export const ALL = (1n << 53n) - 1n;

/** Server-level permissions a monitoring bot must never hold (explicitly or inherited). */
export const FORBIDDEN_BASE: readonly PermName[] = ["ADMINISTRATOR", "MANAGE_GUILD", "MANAGE_CHANNELS", "MANAGE_ROLES", "MANAGE_MESSAGES", "MANAGE_WEBHOOKS", "MANAGE_THREADS", "KICK_MEMBERS", "BAN_MEMBERS", "MODERATE_MEMBERS", "VIEW_AUDIT_LOG"];
/** Inherited from @everyone in many servers; harmless here because every outbound payload sets allowed_mentions.parse = [], so only a warning. */
export const WARN_BASE: readonly PermName[] = ["MENTION_EVERYONE"];
/** The only channel permissions the bot needs in its own channel. */
export const NEEDED_IN_OWN_CHANNEL: readonly PermName[] = ["VIEW_CHANNEL", "SEND_MESSAGES", "EMBED_LINKS"];

export interface Role { id: string; name: string; permissions: string; position?: number; managed?: boolean }
export interface Overwrite { id: string; type: number; allow: string; deny: string }   // type 0 = role, 1 = member
export interface Channel { id: string; name: string; type: number; parent_id: string | null; guild_id?: string; permission_overwrites?: Overwrite[] }

const big = (s: string | undefined): bigint => { try { return BigInt(s ?? "0"); } catch { return 0n; } };

export function basePermissions(guildId: string, roles: readonly Role[], memberRoleIds: readonly string[]): bigint {
  const everyone = roles.find((r) => r.id === guildId);
  let perms = big(everyone?.permissions);
  for (const id of memberRoleIds) { const r = roles.find((x) => x.id === id); if (r) perms |= big(r.permissions); }
  return (perms & PERM.ADMINISTRATOR) !== 0n ? ALL : perms;
}

export function channelPermissions(base: bigint, channel: Channel, guildId: string, memberId: string | null, memberRoleIds: readonly string[]): bigint {
  if ((base & PERM.ADMINISTRATOR) !== 0n) return ALL;
  const ows = channel.permission_overwrites ?? [];
  let perms = base;
  const everyone = ows.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) perms = (perms & ~big(everyone.deny)) | big(everyone.allow);
  let allow = 0n; let deny = 0n;
  for (const id of memberRoleIds) { const o = ows.find((x) => x.type === 0 && x.id === id); if (o) { allow |= big(o.allow); deny |= big(o.deny); } }
  perms = (perms & ~deny) | allow;
  if (memberId !== null) { const m = ows.find((o) => o.type === 1 && o.id === memberId); if (m) perms = (perms & ~big(m.deny)) | big(m.allow); }
  return perms;
}

export const has = (perms: bigint, name: PermName): boolean => (perms & PERM[name]) === PERM[name];
export const names = (perms: bigint, list: readonly PermName[]): PermName[] => list.filter((n) => has(perms, n));
/** Without View Channel nothing else in the channel is usable. */
export const canView = (perms: bigint): boolean => has(perms, "VIEW_CHANNEL");
