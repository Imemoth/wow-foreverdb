import { expect, test } from "@playwright/test";
import { json, post } from "../account/helpers";
import { companionWithInstallation, link, startClaim, webUser } from "./world";
import { admin, fingerprint, ingest, ownerOf, registeredSession, resetBudgets, rpc, sha, snapshot, uniq } from "./stack";
import type pg from "pg";

/**
 * Integrated acceptance: two registered accounts + anonymous owners, overlapping guild names, private Guildbook, the 50-installation
 * cap, pagination limits, history preservation and aggregate statistics (scenarios 15-16, 23, 28-29 and the privacy tests).
 */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

test("privacy: A, B and an anonymous owner each hold an installation with the SAME guild key and name; nobody can read another's data, not even with the real ids", async ({ playwright }) => {
  const a = await webUser(playwright, "privA");
  const b = await webUser(playwright, "privB");
  const ca = await companionWithInstallation({ guilds: 2, members: 5, tag: "AA" });
  const cb = await companionWithInstallation({ guilds: 2, members: 3, tag: "BB" });
  const cc = await companionWithInstallation({ guilds: 2, members: 2, tag: "CC" }); // stays anonymous
  expect((await link(a.c, await startClaim(ca), a.password)).status()).toBe(200);
  expect((await link(b.c, await startClaim(cb), b.password)).status()).toBe(200);
  const key = "Realm:Guild1"; // identical in all three installations

  const read = async (u: typeof a, installationId: string) => ({
    guilds: (await json<{ guilds: unknown[] }>(await post(u.c, "/account/api/guildbook/guilds", { installationId }))).guilds,
    members: (await json<{ members: { name: string }[] }>(await post(u.c, "/account/api/guildbook/members", { installationId, guildKey: key, page: 0 }))).members,
  });
  const own = await read(a, ca.installationId);
  expect(own.guilds).toHaveLength(2);
  expect(own.members.map((m) => m.name).sort()).toEqual(["AA1x1", "AA1x2", "AA1x3", "AA1x4", "AA1x5"]);
  // A -> B's, A -> the anonymous owner's, B -> A's, B -> the anonymous owner's: all EMPTY and indistinguishable from "no such installation"
  for (const [who, target] of [[a, cb], [a, cc], [b, ca], [b, cc]] as const) {
    const r = await read(who, target.installationId);
    expect(r, `${who.email} -> ${target.installationId}`).toEqual({ guilds: [], members: [] });
  }
  const nothing = await read(a, "no-such-installation-0");
  expect(nothing).toEqual({ guilds: [], members: [] });
  // the lists are scoped too
  expect((await json<{ installations: { installationId: string }[] }>(await a.c.get("/account/api/installations"))).installations.map((i) => i.installationId)).toEqual([ca.installationId]);
  expect((await json<{ installations: { installationId: string }[] }>(await b.c.get("/account/api/installations"))).installations.map((i) => i.installationId)).toEqual([cb.installationId]);
  // the same through the Companion's own registered session straight at PostgREST
  const aCompanion = await registeredSession(a.email, a.password);
  expect((await rpc(aCompanion.token, "fdb_account_guildbook_members", { p_installation_id: cb.installationId, p_guild_key: key, p_limit: 200, p_offset: 0 })).body).toEqual([]);
  expect((await rpc(aCompanion.token, "fdb_account_guildbook_members", { p_installation_id: ca.installationId, p_guild_key: key, p_limit: 200, p_offset: 0 })).body).toHaveLength(5);
  // the anonymous owner cannot use the account Guildbook at all (not a registered account): 403, no data
  const anonRead = await rpc(cc.id.token, "fdb_account_guildbook_guilds", { p_installation_id: cc.installationId });
  expect(anonRead.status).toBe(403);
  expect(JSON.stringify(anonRead.body)).not.toContain("CC");
  // website pages: only own ids; no cookie -> sign-in; the other account's id never appears in HTML
  expect(await (await a.c.get("/account/guildbook")).text()).not.toContain(cb.installationId);
  expect((await post(await (await import("../account/helpers")).newClient(playwright), "/account/api/guildbook/guilds", { installationId: ca.installationId })).status()).toBe(401);
});

test("pagination and response-size limits cannot be bypassed (website and PostgREST)", async ({ playwright }) => {
  const a = await webUser(playwright, "page");
  const big = await companionWithInstallation({ guilds: 1, members: 120, tag: "PG" });
  expect((await link(a.c, await startClaim(big), a.password)).status()).toBe(200);
  const key = "Realm:Guild1";
  const page = async (p: number) => json<{ members: { name: string }[]; pageSize: number; page: number }>(await post(a.c, "/account/api/guildbook/members", { installationId: big.installationId, guildKey: key, page: p }));
  const p0 = await page(0), p1 = await page(1), p2 = await page(2), p3 = await page(3);
  expect([p0.members.length, p1.members.length, p2.members.length, p3.members.length]).toEqual([50, 50, 20, 0]);
  expect(p0.pageSize).toBe(50);
  const names = [...p0.members, ...p1.members, ...p2.members].map((m) => m.name);
  expect(new Set(names).size).toBe(120); // no overlap, no gap
  // every attempt to choose the page size / offset / unknown fields is refused by the strict body
  for (const extra of [{ limit: 200 }, { limit: 5000 }, { offset: 0 }, { p_limit: 200 }, { pageSize: 200 }, { installation: "x" }]) {
    const r = await post(a.c, "/account/api/guildbook/members", { installationId: big.installationId, guildKey: key, page: 0, ...extra });
    expect(r.status(), JSON.stringify(extra)).toBe(400);
  }
  for (const bad of [-1, 1001, 1.5, "1", null]) {
    expect((await post(a.c, "/account/api/guildbook/members", { installationId: big.installationId, guildKey: key, page: bad })).status()).toBe(400);
  }
  expect((await post(a.c, "/account/api/guildbook/members", { installationId: "x".repeat(200), guildKey: key, page: 0 })).status()).toBe(400);
  expect((await post(a.c, "/account/api/guildbook/members", { installationId: big.installationId, guildKey: "g".repeat(300), page: 0 })).status()).toBe(400);
  // the database itself bounds a direct caller too: limits are CLAMPED to 1..200, offsets to 0..100000, ids/keys are validated (PT400)
  const aCompanion = await registeredSession(a.email, a.password);
  const direct = (limit: number, offset: number) => rpc(aCompanion.token, "fdb_account_guildbook_members", { p_installation_id: big.installationId, p_guild_key: key, p_limit: limit, p_offset: offset });
  expect((await direct(200, 0)).body).toHaveLength(120);
  for (const [l, o, n] of [[201, 0, 120], [1000000, 0, 120], [0, 0, 1], [-5, 0, 1], [10, -1, 10], [200, 100000, 0], [200, 2147483647, 0]] as const) {
    const r = await direct(l, o);
    expect([r.status, r.body.length], `${l}/${o}`).toEqual([200, n]);
    expect(r.body.length).toBeLessThanOrEqual(200);
  }
  expect((await direct(10, 115)).body).toHaveLength(5);
  for (const bad of [{ p_installation_id: "bad id with spaces", p_guild_key: key }, { p_installation_id: big.installationId, p_guild_key: "" }, { p_installation_id: big.installationId, p_guild_key: "g".repeat(201) }, { p_installation_id: "x".repeat(129), p_guild_key: key }]) {
    const r = await rpc(aCompanion.token, "fdb_account_guildbook_members", { ...bad, p_limit: 10, p_offset: 0 });
    expect([r.status, r.body.code]).toEqual([400, "PT400"]);
  }
});

test("23. the 50-installation cap: a valid code is NOT consumed at the limit, and is still redeemable by another account", async ({ playwright }) => {
  const a = await webUser(playwright, "cap");
  const other = await webUser(playwright, "capother");
  // 49 installations already owned by A (fixtures straight in the table, like a native registered owner), plus one claimed through the website
  for (let i = 0; i < 49; i += 1) {
    await db.query("insert into public.installations (id, schema_version, addon_version, owner_user_id) values ($1, 9, 'e2e-fixture', $2)", [uniq("cap"), a.uid]);
  }
  const first = await companionWithInstallation();
  expect((await link(a.c, await startClaim(first), a.password)).status()).toBe(200);
  expect((await db.query("select count(*)::int n from public.installations where owner_user_id = $1", [a.uid])).rows[0].n).toBe(50);

  const extra = await companionWithInstallation();
  const code = await startClaim(extra);
  const full = await link(a.c, code, a.password);
  expect(full.status()).toBe(409);
  expect(await json(full)).toEqual({ ok: false, error: "account_limit" });
  expect(await ownerOf(db, extra.installationId)).toBe(extra.id.uid);
  expect((await db.query("select status, attempts from private.installation_claims where installation_id = $1", [extra.installationId])).rows).toEqual([{ status: "pending", attempts: 0 }]);
  // the list is bounded at 50 and still served
  const list = await json<{ installations: unknown[] }>(await a.c.get("/account/api/installations"));
  expect(list.installations).toHaveLength(50);
  expect((await (await a.c.get("/account/installations")).text()).match(/data-testid="installation-row"/g)).toHaveLength(50);
  // the unconsumed code works for an account that has room
  const ok = await link(other.c, code, other.password);
  expect(ok.status()).toBe(200);
  expect(await ownerOf(db, extra.installationId)).toBe(other.uid);
});

test("28-29. historical rows, stable hashes and aggregate statistics are identical before and after a transfer", async ({ playwright }) => {
  const a = await webUser(playwright, "hist");
  const noise = await companionWithInstallation({ sources: 3, guilds: 1, members: 3, tag: "N1" });
  const mover = await companionWithInstallation({ sources: 3, guilds: 2, members: 4, tag: "MV" });
  void noise;
  const reader = await registeredSession(a.email, a.password);
  const stats = async () => {
    await resetBudgets(db);
    const out: Record<string, unknown> = {};
    for (const item of [7001, 7002, 7003, 8001]) {
      const r = await rpc(reader.token, "get_foreverdb_item_stats", { p_item_id: item });
      expect(r.status, `stats ${item}`).toBe(200); // never compare error bodies
      expect(Array.isArray(r.body) && r.body.length > 0, `stats ${item} non-empty`).toBe(true);
      out[item] = r.body;
    }
    return out;
  };
  const rowsBefore = await fingerprint(db);
  const statsBefore = await stats();
  expect(JSON.stringify(statsBefore).length).toBeGreaterThan(200);
  const ownersBefore = (await db.query("select id, owner_user_id from public.installations order by id")).rows;

  expect((await link(a.c, await startClaim(mover), a.password)).status()).toBe(200);

  const rowsAfter = await fingerprint(db);
  for (const t of Object.keys(rowsBefore)) expect(rowsAfter[t], `${t}`).toEqual(rowsBefore[t]);
  expect(sha(await stats())).toBe(sha(statsBefore));
  const ownersAfter = (await db.query("select id, owner_user_id from public.installations order by id")).rows;
  const changed = ownersAfter.filter((r, i) => r.owner_user_id !== ownersBefore[i]!.owner_user_id);
  expect(changed.map((r) => r.id)).toEqual([mover.installationId]); // exactly one installation changed owner
  // the transferred installation keeps every observation (row counts per table for it)
  const count = (await db.query("select (select count(*) from public.installation_item_stats where installation_id = $1)::int i, (select count(*) from public.installation_source_stats where installation_id = $1)::int s, (select count(*) from public.installation_guild_members where installation_id = $1)::int m", [mover.installationId])).rows[0];
  expect(count).toMatchObject({ s: 3, m: 8 });
  // re-syncing the same data under the new owner (Companion signed in with the account) replaces, never doubles
  await resetBudgets(db);
  expect((await ingest(reader.token, snapshot(mover.installationId, { updatedAt: 2000, sources: 3, guilds: 2, members: 4, tag: "MV" }))).status).toBe(200);
  const resynced = await fingerprint(db);
  for (const t of Object.keys(rowsBefore)) expect(resynced[t]!.n, `${t} row count after re-sync`).toBe(rowsBefore[t]!.n); // replaced, not doubled
});
