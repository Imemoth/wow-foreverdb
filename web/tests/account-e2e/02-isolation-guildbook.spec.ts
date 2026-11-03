import { expect, test } from "@playwright/test";
import { json, newClient, post } from "../account/helpers";
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

test("privacy: the Guildbook is Companion-local: nothing of it is stored, the website routes are 404 and the retired RPCs are denied to every role, not even with the real ids", async ({ playwright }) => {
  const a = await webUser(playwright, "privA");
  const b = await webUser(playwright, "privB");
  // an old Companion still uploads a Guildbook (same guild key and names everywhere): migration 0018 drops it before the legacy ingest
  const ca = await companionWithInstallation({ guilds: 2, members: 5, tag: "AA" });
  const cb = await companionWithInstallation({ guilds: 2, members: 3, tag: "BB" });
  const cc = await companionWithInstallation({ guilds: 2, members: 2, tag: "CC" }); // stays anonymous
  expect((await link(a.c, await startClaim(ca), a.password)).status()).toBe(200);
  expect((await link(b.c, await startClaim(cb), b.password)).status()).toBe(200);
  const key = "Realm:Guild1";
  const ids = [ca.installationId, cb.installationId, cc.installationId];
  expect((await db.query("select count(*)::int n from public.installation_guilds where installation_id = any($1)", [ids])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from public.installation_guild_members where installation_id = any($1)", [ids])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from public.installation_guild_professions where installation_id = any($1)", [ids])).rows[0].n).toBe(0);

  // website: a bare 404 for the owner, another account and a visitor with no session (no authentication, no body validation, no RPC)
  const visitor = await newClient(playwright);
  for (const client of [a.c, b.c, visitor]) {
    for (const [path, body] of [
      ["/account/api/guildbook/guilds", { installationId: ca.installationId }],
      ["/account/api/guildbook/members", { installationId: ca.installationId, guildKey: key, page: 0 }],
      ["/account/api/guildbook/members", { limit: 200 }],
    ] as const) {
      expect((await post(client, path, body)).status(), path).toBe(404);
    }
    expect((await client.get("/account/guildbook")).status()).toBe(404);
  }
  // the lists are scoped too
  expect((await json<{ installations: { installationId: string }[] }>(await a.c.get("/account/api/installations"))).installations.map((i) => i.installationId)).toEqual([ca.installationId]);
  expect((await json<{ installations: { installationId: string }[] }>(await b.c.get("/account/api/installations"))).installations.map((i) => i.installationId)).toEqual([cb.installationId]);
  // the Companion's own registered session and the anonymous owner straight at PostgREST: migration 0018 revoked every Guildbook RPC (42501 permission denied)
  const aCompanion = await registeredSession(a.email, a.password);
  for (const [token, label] of [[aCompanion.token, "registered owner"], [cc.id.token, "anonymous owner"]] as const) {
    for (const [name, args] of [
      ["fdb_account_guildbook_guilds", { p_installation_id: ca.installationId }],
      ["fdb_account_guildbook_members", { p_installation_id: ca.installationId, p_guild_key: key, p_limit: 200, p_offset: 0 }],
    ] as const) {
      const r = await rpc(token, name, args);
      expect([401, 403, 404], `${label} ${name}`).toContain(r.status);
      expect(JSON.stringify(r.body), `${label} ${name}`).not.toMatch(/AA1x|BB1x|CC1x|Guild 1/);
    }
  }
});

test("the retired Guildbook routes ignore the request entirely: no strict-body 400s, no paging, no oracle (website and PostgREST)", async ({ playwright }) => {
  const a = await webUser(playwright, "page");
  const big = await companionWithInstallation({ guilds: 1, members: 120, tag: "PG" });
  expect((await link(a.c, await startClaim(big), a.password)).status()).toBe(200);
  const key = "Realm:Guild1";
  const members = [
    { installationId: big.installationId, guildKey: key, page: 0 },
    ...[{ limit: 200 }, { limit: 5000 }, { offset: 0 }, { p_limit: 200 }, { pageSize: 200 }, { installation: "x" }].map((extra) => ({ installationId: big.installationId, guildKey: key, page: 0, ...extra })),
    ...[-1, 1001, 1.5, "1", null].map((page) => ({ installationId: big.installationId, guildKey: key, page })),
    { installationId: "x".repeat(200), guildKey: key, page: 0 },
    { installationId: big.installationId, guildKey: "g".repeat(300), page: 0 },
  ];
  // every shape (valid, oversized, malformed) gets the same answer: 404 (a 400 would reveal that a body schema still exists)
  for (const body of members) expect((await post(a.c, "/account/api/guildbook/members", body)).status(), JSON.stringify(body).slice(0, 80)).toBe(404);
  expect((await post(a.c, "/account/api/guildbook/guilds", { installationId: big.installationId })).status()).toBe(404);
  // directly at PostgREST there is no page to bound any more: the function is not callable (and never returns rows)
  const aCompanion = await registeredSession(a.email, a.password);
  for (const [l, o] of [[200, 0], [201, 0], [1000000, 0], [0, 0], [-5, 0], [200, 100000]] as const) {
    const r = await rpc(aCompanion.token, "fdb_account_guildbook_members", { p_installation_id: big.installationId, p_guild_key: key, p_limit: l, p_offset: o });
    expect([401, 403, 404], `${l}/${o}`).toContain(r.status);
    expect(Array.isArray(r.body)).toBe(false);
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
  expect(count).toMatchObject({ s: 3, m: 0 }); // observations stay; the Guildbook is never stored (0018)
  // re-syncing the same data under the new owner (Companion signed in with the account) replaces, never doubles
  await resetBudgets(db);
  expect((await ingest(reader.token, snapshot(mover.installationId, { updatedAt: 2000, sources: 3, guilds: 2, members: 4, tag: "MV" }))).status).toBe(200);
  const resynced = await fingerprint(db);
  for (const t of Object.keys(rowsBefore)) expect(resynced[t]!.n, `${t} row count after re-sync`).toBe(rowsBefore[t]!.n); // replaced, not doubled
});
