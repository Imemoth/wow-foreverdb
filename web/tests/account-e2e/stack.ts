/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the servers under test are inspected structurally by the assertions */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Coordinates and clients of the integrated stack (real GoTrue + real PostgREST + PostgreSQL). `playwright.account-e2e.config.ts`
 * exports them into the environment. The "Companion" here is just a test client that holds real GoTrue tokens and calls PostgREST.
 */
const env = process.env as Record<string, string | undefined>;
export const GATEWAY = env.ACCOUNT_STACK_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY = env.ACCOUNT_STACK_ANON_KEY ?? "";
export const REST_DIRECT = env.E2E_POSTGREST_URL ?? "http://127.0.0.1:54323";
export const REST_OVERRIDE = env.E2E_POSTGREST_OVERRIDE_URL ?? "http://127.0.0.1:54328";
export const JWT_SECRET = env.E2E_JWT_SECRET ?? "";
export const DB = env.E2E_DB ?? "fdb_account_it";
export const STACK_DIR = env.E2E_STACK_DIR ?? "";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Reply { status: number; headers: Record<string, string>; body: any }
async function parse(res: Response): Promise<Reply> {
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, headers: Object.fromEntries(res.headers), body };
}

/** One PostgREST RPC call exactly like the Companion makes it: through the gateway, publishable key + the caller's own bearer. */
export async function rpc(token: string, name: string, args: unknown = {}, o: { headers?: Record<string, string>; base?: string } = {}): Promise<Reply> {
  const res = await fetch(`${o.base ?? `${GATEWAY}/rest/v1`}/rpc/${name}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json", ...(o.headers ?? {}) },
    body: JSON.stringify(args),
  });
  return parse(res);
}
/** A table/view read through PostgREST (negative tests: private data must not be reachable this way). */
export async function restGet(token: string | null, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${GATEWAY}/rest/v1/${path}`, { headers: { apikey: ANON_KEY, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return parse(res);
}
export async function auth(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<Reply> {
  const res = await fetch(`${GATEWAY}/auth/v1${path}`, {
    method: init.method ?? "POST",
    headers: { apikey: ANON_KEY, "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return parse(res);
}

export const claimsOf = (token: string): Record<string, any> => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

export interface Identity { token: string; refresh: string; uid: string; sid: string; email?: string }

/** A Companion-style ANONYMOUS identity (what the production Companion signs in as today). */
export async function anonymous(): Promise<Identity> {
  const r = await auth("/signup", { body: {} });
  if (r.status !== 200) throw new Error(`anonymous sign-in answered ${r.status}`);
  return { token: r.body.access_token, refresh: r.body.refresh_token, uid: r.body.user.id, sid: claimsOf(r.body.access_token).session_id };
}
/** A REGISTERED identity signing in from the Companion (password grant straight at Auth: its own session, independent of the website's). */
export async function registeredSession(email: string, password: string): Promise<Identity> {
  const r = await auth("/token?grant_type=password", { body: { email, password } });
  if (r.status !== 200) throw new Error(`password grant answered ${r.status}`);
  return { token: r.body.access_token, refresh: r.body.refresh_token, uid: r.body.user.id, sid: claimsOf(r.body.access_token).session_id, email };
}
export async function logoutLocal(token: string): Promise<number> {
  return (await auth("/logout?scope=local", { token })).status;
}

// ------------------------------------------------------------------------------------------------ database (verification only)
/** Direct database connection used ONLY to verify outcomes (the application path always goes through PostgREST). */
export async function admin(): Promise<pg.Client> {
  const c = new pg.Client({ host: env.PGHOST ?? "127.0.0.1", port: Number(env.PGPORT ?? 5432), database: DB, user: "fdb_migrator", password: "local-test-password" });
  await c.connect();
  return c;
}

/** Superuser connection of the DISPOSABLE cluster: needed only to observe other backends' lock waits in pg_stat_activity. */
export async function superAdmin(): Promise<pg.Client> {
  const c = new pg.Client({ host: env.PGHOST ?? "127.0.0.1", port: Number(env.PGPORT ?? 5432), database: DB, user: env.PGUSER, password: env.PGPASSWORD });
  await c.connect();
  return c;
}

export const DATA_TABLES = [
  "public.installations", "public.sources", "public.items", "public.installation_source_stats", "public.installation_location_stats",
  "public.installation_item_stats", "public.installation_guilds", "public.installation_guild_members", "public.installation_guild_professions",
];
/** Row counts + stable hashes of every history table (owner_user_id is the single column allowed to change, fingerprinted apart). */
export async function fingerprint(db: pg.Client): Promise<Record<string, { n: number; h: string }>> {
  const out: Record<string, { n: number; h: string }> = {};
  for (const t of DATA_TABLES) {
    const expr = t === "public.installations" ? "to_jsonb(x) - 'owner_user_id'" : "to_jsonb(x)";
    const r = await db.query(`select count(*)::int n, coalesce(md5(string_agg(j::text, '|' order by j::text)), '') h from (select ${expr} as j from ${t} x) s`);
    out[t] = r.rows[0];
  }
  return out;
}
export const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const resetBudgets = (db: pg.Client) => db.query("delete from private.foreverdb_api_budgets");
export const ownerOf = async (db: pg.Client, installationId: string): Promise<string | null> =>
  (await db.query("select owner_user_id from public.installations where id = $1", [installationId])).rows[0]?.owner_user_id ?? null;
export const claimRows = async (db: pg.Client, installationId: string) =>
  (await db.query("select * from private.installation_claims where installation_id = $1 order by created_at", [installationId])).rows;
export const sessionCount = async (db: pg.Client, uid: string): Promise<number> =>
  (await db.query("select count(*)::int n from auth.sessions where user_id = $1", [uid])).rows[0].n;

export const uniq = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** A snapshot the real ingest function accepts: sources with loot, locations, quest drops, and (as an old Companion would send it) guilds with members and professions, which migration 0018 drops. */
export function snapshot(installationId: string, o: { updatedAt?: number; sources?: number; guilds?: number; members?: number; tag?: string } = {}) {
  const { updatedAt = 1000, sources = 3, guilds = 2, members = 4, tag = "M" } = o;
  const src = [];
  for (let s = 1; s <= sources; s += 1) {
    src.push({
      sourceType: "creature", sourceId: 9000 + s, sourceLevel: 60 + s, name: `Creature ${s}`,
      buckets: [{
        kind: "mob", observations: 100 * s,
        locations: [{ mapId: 1, zoneName: "Durotar", subZoneName: "Razor Hill", x: 10.5 + s, y: 20.25, observations: 40 * s }],
        items: [
          { itemId: 7000 + s, name: `Item ${s}`, drops: 10 * s, quantity: 12 * s, questDrops: 0, questIds: [] },
          { itemId: 8000 + s, name: `Quest item ${s}`, drops: 3, quantity: 3, questDrops: 3, questIds: [101, 102] },
        ],
      }],
    });
  }
  const gl = [];
  for (let g = 1; g <= guilds; g += 1) {
    const mem = [];
    for (let m = 1; m <= members; m += 1) {
      mem.push({
        guid: `Player-${tag}-${g}-${m}`, name: `${tag}${g}x${m}`, className: "Mage", classFile: "MAGE", level: 60 + (m % 10),
        rankName: m === 1 ? "Guild Master" : "Member", rankIndex: m === 1 ? 0 : 3, online: m % 2 === 0, zone: "Orgrimmar", lastOnlineHours: m,
        professions: [{ skillLineId: 164, name: "Blacksmithing", skill: 300 + (m % 70), maxSkill: 375, source: "scan", isSecondary: false }],
      });
    }
    // OVERLAPPING guild keys and names across installations on purpose: the key alone must never select another account's data.
    gl.push({ guildKey: `Realm:Guild${g}`, name: `Guild ${g}`, realmName: "Realm", capturedAt: 5000 + g, members: mem });
  }
  return { installationId, schemaVersion: 9, addonVersion: "e2e-test", updatedAt, sources: src, guilds: gl };
}
export const ingest = (token: string, snap: unknown) => rpc(token, "ingest_foreverdb_snapshot_auth", { p_snapshot: snap });

let budgetDb: pg.Client | null = null;
/** Keeps the DATABASE's GLOBAL ingest / claim-start ceilings from throttling fixture creation (they are alarms shared by the whole run; the per-account budgets under test are untouched). */
export async function relaxFixtureCeilings(): Promise<void> {
  budgetDb ??= await admin();
  await budgetDb.query("delete from private.foreverdb_api_budgets where bucket in ('ingest:global', 'claim_start:global')");
}
