// Shared helpers for the Account System V1 integration suite (real PostgreSQL + real GoTrue, disposable database only).
//
// "PostgREST layer": there is no PostgREST in this stack. `asUser` / `verifyJwt` do exactly what PostgREST does for an RPC call:
// verify the HS256 signature and `exp` of the bearer token, then, inside ONE transaction, `SET LOCAL ROLE authenticated` and
// expose the verified claims through the `request.jwt.claims` setting. Everything behind that (auth.uid(), auth.jwt(), the
// SECURITY DEFINER functions, auth.sessions, auth.users) is the real thing. Tests that use fixture rows insert them into the REAL
// GoTrue-created auth tables.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
const require = createRequire(path.join(repoRoot, "web", "package.json"));
export const pg = require("pg");

export const DB = process.env.FDB_IT_DB ?? "fdb_account_it";
export const HOST = process.env.PGHOST ?? "127.0.0.1";
export const PORT = Number(process.env.PGPORT ?? 5432);
export const GOTRUE_URL = process.env.GOTRUE_URL ?? "http://127.0.0.1:9999";
export const JWT_SECRET = process.env.GOTRUE_JWT_SECRET ?? "local-test-only-jwt-secret-0123456789abcdef0123456789abcdef";
export const RUN_DIR = process.env.FDB_IT_RUN_DIR ?? path.join(here, ".run");

// The migration role stands in for Supabase's `postgres` (owner of every account function, BYPASSRLS, all rights on auth.*).
const MIGRATOR = { user: "fdb_migrator", password: "local-test-password" };

export async function connect(database = DB, who = MIGRATOR) {
  const client = new pg.Client({ host: HOST, port: PORT, database, user: who.user, password: who.password });
  await client.connect();
  return client;
}
export async function connectSuper(database = DB) {
  const client = new pg.Client({
    host: HOST,
    port: PORT,
    database,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------------------------------------------------
// JWT: what PostgREST does
// ---------------------------------------------------------------------------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Signs claims like GoTrue does (HS256). Only used to forge tokens for NEGATIVE tests of the harness itself. */
export function signJwt(claims, secret = JWT_SECRET) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64u(sig)}`;
}

/** Verifies signature and expiry (PostgREST's responsibility) and returns the claims, or throws. */
export function verifyJwt(token, secret = JWT_SECRET, now = Date.now() / 1000) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed jwt");
  const expected = createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("jwt expired");
  return claims;
}

export const decodeClaims = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));

/** Claims for a fixture session (the shape GoTrue issues: sub, role, session_id, is_anonymous, future exp). */
export function claimsFor({ uid, sid, anonymous = false, role = "authenticated", exp = Math.floor(Date.now() / 1000) + 3600, omit = [], extra = {} }) {
  const c = { sub: uid, aud: "authenticated", role, session_id: sid, is_anonymous: anonymous, exp, iat: exp - 3600, ...extra };
  for (const k of omit) delete c[k];
  return c;
}

/**
 * Runs `fn(q)` in one transaction as role `authenticated` with the given verified claims, like a PostgREST request.
 * `q(sql, params)` returns rows. Commits when fn resolves; rolls back and rethrows otherwise.
 */
export async function asUser(client, claims, fn, { role = "authenticated", commit = true } = {}) {
  await client.query("begin");
  try {
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

/** One RPC call as a user: returns the function's result (jsonb object, or array of rows for set-returning functions). */
export async function rpc(client, claims, name, args = [], options) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  return asUser(
    client,
    claims,
    async (q) => {
      const rows = await q(`select * from public.${name}(${placeholders})`, args);
      // scalar jsonb functions come back as a single column named after the function
      if (rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.keys(rows[0])[0] === name) return rows[0][name];
      return rows;
    },
    options,
  );
}

/** Expects a rejection with the given SQLSTATE (PostgREST maps PT401 -> HTTP 401). */
export async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    if (error.code === code) return error;
    throw new Error(`expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  }
  throw new Error(`expected SQLSTATE ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures in the REAL GoTrue tables (inserted as the migration role)
// ---------------------------------------------------------------------------------------------------------------------
export class Fixtures {
  constructor(admin) {
    this.admin = admin;
  }

  async user({ anonymous = false, confirmed = true, email } = {}) {
    const uid = randomUUID();
    await this.admin.query(
      `insert into auth.users (id, aud, role, email, is_anonymous, email_confirmed_at, created_at, updated_at)
       values ($1, 'authenticated', 'authenticated', $2, $3, $4, now(), now())`,
      [uid, anonymous ? null : (email ?? `user-${uid}@example.invalid`), anonymous, !anonymous && confirmed ? new Date() : null],
    );
    return uid;
  }

  async session(uid, { notAfter = null } = {}) {
    const sid = randomUUID();
    await this.admin.query(`insert into auth.sessions (id, user_id, created_at, updated_at, not_after) values ($1, $2, now(), now(), $3)`, [sid, uid, notAfter]);
    return sid;
  }

  /** user + live session, returning ready-to-use claims. */
  async identity({ anonymous = false, confirmed = true } = {}) {
    const uid = await this.user({ anonymous, confirmed });
    const sid = await this.session(uid);
    return { uid, sid, anonymous, claims: claimsFor({ uid, sid, anonymous }) };
  }

  async installation(id, ownerUid, { firstSeen } = {}) {
    await this.admin.query(
      `insert into public.installations (id, owner_user_id, schema_version, addon_version, snapshot_updated_at, first_seen_at, last_seen_at)
       values ($1, $2, 9, 'it-test', 1000, coalesce($3::timestamptz, now()), now())`,
      [id, ownerUid, firstSeen ?? null],
    );
    return id;
  }

  async guild(installationId, guildKey, members) {
    await this.admin.query(
      `insert into public.installation_guilds (installation_id, guild_key, guild_name, realm_name, captured_at) values ($1, $2, $3, 'Realm', 12345)`,
      [installationId, guildKey, `Guild ${guildKey}`],
    );
    for (const m of members) {
      await this.admin.query(
        `insert into public.installation_guild_members (installation_id, guild_key, member_guid, member_name, class_name, class_file, level, rank_name, rank_index, online, zone_name, last_online_hours)
         values ($1, $2, $3, $4, 'Warrior', 'WARRIOR', $5, $6, $7, false, 'Zone', 3)`,
        [installationId, guildKey, m.guid, m.name, m.level ?? 80, m.rank ?? "Member", m.rankIndex ?? 5],
      );
    }
  }

  async resetBudgets() {
    await this.admin.query("delete from private.foreverdb_api_budgets");
  }

  async owner(installationId) {
    const r = await this.admin.query("select owner_user_id from public.installations where id = $1", [installationId]);
    return r.rows[0]?.owner_user_id ?? null;
  }
  async claimRows(installationId) {
    return (await this.admin.query("select * from private.installation_claims where installation_id = $1 order by created_at", [installationId])).rows;
  }
  async audit(installationId) {
    return (await this.admin.query("select event, account_uid, installation_id, claim_id from private.account_audit where installation_id = $1 order by id", [installationId])).rows;
  }
}

export const uniq = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------------------------------------------------
// Real GoTrue client
// ---------------------------------------------------------------------------------------------------------------------
export async function gotrue(pathAndQuery, { method = "POST", body, token, headers = {} } = {}) {
  const res = await fetch(`${GOTRUE_URL}${pathAndQuery}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

/** Service-role token for GoTrue's admin API (signed with the stack's test-only secret). */
export const adminToken = () => signJwt({ role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 });

export async function gotrueAvailable() {
  try {
    const r = await fetch(`${GOTRUE_URL}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(RUN_DIR, file), "utf8"));
}

/** A realistic schema-9 Companion snapshot (what ingest_foreverdb_snapshot_auth receives). */
export function snapshot(installationId, { updatedAt = 1000, sources = 3, guilds = 2, members = 4 } = {}) {
  const src = [];
  for (let s = 1; s <= sources; s += 1) {
    src.push({
      sourceType: "creature",
      sourceId: 9000 + s,
      sourceLevel: 60 + s,
      name: `Creature ${s}`,
      buckets: [
        {
          kind: "mob",
          observations: 100 * s,
          locations: [{ mapId: 1, zoneName: "Durotar", subZoneName: "Razor Hill", x: 10.5 + s, y: 20.25, observations: 40 * s }],
          items: [
            { itemId: 7000 + s, name: `Item ${s}`, drops: 10 * s, quantity: 12 * s, questDrops: 0, questIds: [] },
            { itemId: 8000 + s, name: `Quest item ${s}`, drops: 3, quantity: 3, questDrops: 3, questIds: [101, 102] },
          ],
        },
      ],
    });
  }
  const gl = [];
  for (let g = 1; g <= guilds; g += 1) {
    const mem = [];
    for (let m = 1; m <= members; m += 1) {
      mem.push({
        guid: `Player-${g}-${m}`,
        name: `Member${g}x${m}`,
        className: "Mage",
        classFile: "MAGE",
        level: 60 + m,
        rankName: m === 1 ? "Guild Master" : "Member",
        rankIndex: m === 1 ? 0 : 3,
        online: m % 2 === 0,
        zone: "Orgrimmar",
        lastOnlineHours: m,
        professions: [{ skillLineId: 164, name: "Blacksmithing", skill: 300 + m, maxSkill: 375, source: "scan", isSecondary: false }],
      });
    }
    gl.push({ guildKey: `Realm:Guild${g}`, name: `Guild ${g}`, realmName: "Realm", capturedAt: 5000 + g, members: mem });
  }
  return { installationId, schemaVersion: 9, addonVersion: "it-test", updatedAt, sources: src, guilds: gl };
}

// ---------------------------------------------------------------------------------------------------------------------
// Concurrency helpers (real, separate connections = separate backends = real concurrent transactions)
// ---------------------------------------------------------------------------------------------------------------------
/** Starts a promise and captures its outcome without creating an unhandled rejection. */
export function settle(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

/** A connection with an open transaction already running as `authenticated` with the given claims. */
export async function openUserTx(claims) {
  const c = await connect();
  await c.query("begin");
  await c.query("set local role authenticated");
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  return c;
}

/** Holds the per-installation advisory lock (the exact ingest key) in an open transaction until release(). */
export async function holdInstallationLock(installationId) {
  const c = await connect();
  await c.query("begin");
  await c.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [installationId]);
  return {
    release: async () => {
      await c.query("commit");
      await c.end();
    },
  };
}

/** Polls until the backend of `client` is waiting on a heavyweight lock (advisory or row/tuple). */
export async function waitUntilBlocked(admin, client, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await admin.query("select wait_event_type from pg_stat_activity where pid = $1", [client.processID]);
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`backend ${client.processID} never blocked on a lock`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function commitTimestamp(admin, xid) {
  const r = await admin.query("select pg_xact_commit_timestamp($1::text::xid) as ts", [xid]);
  return r.rows[0].ts;
}
