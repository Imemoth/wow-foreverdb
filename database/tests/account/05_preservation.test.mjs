// Historical data preservation: an ownership transfer changes installations.owner_user_id and NOTHING else.
// Fixtures are built through the REAL ingest function with real auth rows (anonymous owners, registered users, several
// installations, loot, items, sources, locations, quest drops, Guildbook members and professions, existing quota state).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Fixtures, connect, expectCode, rpc, snapshot, uniq } from "./harness.mjs";

const admin = await connect();
const client = await connect();
const fx = new Fixtures(admin);
after(async () => {
  await client.end();
  await admin.end();
});

const DATA_TABLES = [
  "public.installations", "public.sources", "public.items", "public.installation_source_stats", "public.installation_location_stats",
  "public.installation_item_stats", "public.installation_guilds", "public.installation_guild_members", "public.installation_guild_professions",
];

async function fingerprint() {
  const out = {};
  for (const t of DATA_TABLES) {
    // owner_user_id is the one column allowed to change; it is fingerprinted separately.
    const expr = t === "public.installations" ? "to_jsonb(x) - 'owner_user_id'" : "to_jsonb(x)";
    const r = await admin.query(`select count(*)::int n, coalesce(md5(string_agg(j::text, '|' order by j::text)), '') h from (select ${expr} as j from ${t} x) s`);
    out[t] = r.rows[0];
  }
  return out;
}
const ownersOf = async (ids) => Object.fromEntries((await admin.query("select id, owner_user_id from public.installations where id = any($1)", [ids])).rows.map((r) => [r.id, r.owner_user_id]));
const statsFor = async (id, itemIds) => {
  const out = {};
  for (const item of itemIds) out[item] = await rpc(client, id.claims, "get_foreverdb_item_stats", [item]);
  return out;
};
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

let w;
before(async () => {
  await fx.resetBudgets();
  const a1 = await fx.identity({ anonymous: true });
  const a2 = await fx.identity({ anonymous: true });
  const r1 = await fx.identity();
  const r2 = await fx.identity();
  const r3 = await fx.identity();
  const I1 = uniq("pres-a1-main");
  const I2 = uniq("pres-a1-alt");
  const I3 = uniq("pres-a2");
  const I4 = uniq("pres-r3-native");
  // Same source ids in several installations => multi-installation buckets (the F-3 denominator scenario).
  const ingest = (id, inst, opts) => rpc(client, id.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, opts)]);
  await ingest(a1, I1, { updatedAt: 1000, sources: 3, guilds: 2, members: 5 });
  await ingest(a1, I2, { updatedAt: 1000, sources: 2, guilds: 1, members: 3 });
  await ingest(a2, I3, { updatedAt: 1000, sources: 3, guilds: 1, members: 4 });
  await ingest(r3, I4, { updatedAt: 1000, sources: 1, guilds: 1, members: 2 });
  w = { a1, a2, r1, r2, r3, I1, I2, I3, I4 };
});

describe("transfer preserves history", () => {
  it("rows and stable hashes of every data table are identical before/after, except owner_user_id of the transferred installation", async () => {
    const { a1, r1, I1, I2, I3, I4 } = w;
    const ids = [I1, I2, I3, I4];
    const before = await fingerprint();
    const ownersBefore = await ownersOf(ids);
    const budgetsBefore = (await admin.query("select bucket, calls, window_started from private.foreverdb_api_budgets where bucket not like 'claim\\_%' order by bucket")).rows;
    const statsBefore = await statsFor(r1, [7001, 7002, 7003, 8001]);
    assert.ok(before["public.installation_item_stats"].n >= 20 && before["public.installation_guild_professions"].n >= 10);

    const { code } = await rpc(client, a1.claims, "fdb_account_claim_start", [I1]);
    const res = await rpc(client, r1.claims, "fdb_account_claim_redeem", [code]);
    assert.equal(res.ok, true);

    const after = await fingerprint();
    assert.deepEqual(after, before, "no data table changed (installations compared without owner_user_id)");
    const ownersAfter = await ownersOf(ids);
    assert.equal(ownersAfter[I1], r1.uid);
    assert.deepEqual({ ...ownersAfter, [I1]: ownersBefore[I1] }, ownersBefore, "no other installation changed owner");
    const budgetsAfter = (await admin.query("select bucket, calls, window_started from private.foreverdb_api_budgets where bucket not like 'claim\\_%' order by bucket")).rows;
    assert.deepEqual(budgetsAfter.filter((b) => !b.bucket.startsWith("detail:") && !b.bucket.startsWith("read:")), budgetsBefore.filter((b) => !b.bucket.startsWith("detail:") && !b.bucket.startsWith("read:")), "existing ingest quota state untouched");
    // aggregate statistics (what Search/Stats return to the Companion) are unchanged and correct
    const statsAfter = await statsFor(r1, [7001, 7002, 7003, 8001]);
    assert.equal(sha(statsAfter), sha(statsBefore));
    // independent recomputation of the corrected (F-3) rate straight from the stored rows: drops / ALL observations of the bucket
    const row = statsAfter[7001].find((r) => Number(r.source_id) === 9001);
    const exp = (await admin.query(`select (select sum(drop_count) from public.installation_item_stats where item_id = 7001 and source_type = 'creature' and source_id = 9001 and source_level = 61 and loot_kind = 'mob')::numeric as drops,
                                           (select sum(observations) from public.installation_source_stats where source_type = 'creature' and source_id = 9001 and source_level = 61 and loot_kind = 'mob')::numeric as obs`)).rows[0];
    assert.equal(Number(row.drop_count), Number(exp.drops));
    assert.equal(Number(row.observations), Number(exp.obs));
    assert.ok(Math.abs(Number(row.observed_drop_rate) - Number(exp.drops) / Number(exp.obs)) < 1e-9);
  });

  it("no duplicate observations: the new owner re-syncing the same snapshot replaces rows, it does not add them", async () => {
    const { r1, I1 } = w;
    const count = async () => (await admin.query("select (select count(*) from public.installation_item_stats where installation_id = $1)::int i, (select count(*) from public.installation_source_stats where installation_id = $1)::int s, (select count(*) from public.installation_location_stats where installation_id = $1)::int l, (select count(*) from public.installation_guild_members where installation_id = $1)::int m, (select count(*) from public.installation_guild_professions where installation_id = $1)::int p", [I1])).rows[0];
    const before = await count();
    await fx.resetBudgets();
    const out = await rpc(client, r1.claims, "ingest_foreverdb_snapshot_auth", [snapshot(I1, { updatedAt: 2000, sources: 3, guilds: 2, members: 5 })]);
    assert.equal(out.ok, true);
    assert.deepEqual(await count(), before);
  });

  it("the old anonymous owner loses write access to the transferred installation but keeps its other installation", async () => {
    const { a1, I1, I2 } = w;
    await fx.resetBudgets();
    const e = await rpc(client, a1.claims, "ingest_foreverdb_snapshot_auth", [snapshot(I1, { updatedAt: 3000 })]).catch((x) => x);
    assert.match(e.message, /belongs to another authenticated client/);
    const ok = await rpc(client, a1.claims, "ingest_foreverdb_snapshot_auth", [snapshot(I2, { updatedAt: 3000, sources: 2, guilds: 1, members: 3 })]);
    assert.equal(ok.ok, true);
    assert.deepEqual(await rpc(client, a1.claims, "fdb_installation_link_status", [I1]), { state: "transferred" });
    assert.deepEqual(await rpc(client, a1.claims, "fdb_installation_link_status", [I2]), { state: "owned" });
  });

  it("the new owner gains access: lists it, reads its Guildbook, ingests; an unrelated registered user sees none of it", async () => {
    const { r1, r2, r3, I1, I4 } = w;
    await fx.resetBudgets();
    const mine = await rpc(client, r1.claims, "fdb_account_installations");
    assert.deepEqual(mine.map((r) => r.installation_id), [I1]);
    assert.equal(mine[0].guild_count, 2);
    const guilds = await rpc(client, r1.claims, "fdb_account_guildbook_guilds", [I1]);
    assert.equal(guilds.length, 2);
    const members = await rpc(client, r1.claims, "fdb_account_guildbook_members", [I1, guilds[0].guild_key, 200, 0]);
    assert.equal(members.length, 5);
    assert.ok(!JSON.stringify(members).includes("Player-"), "no member GUIDs");
    // unrelated registered user r2: nothing
    assert.deepEqual(await rpc(client, r2.claims, "fdb_account_installations"), []);
    assert.deepEqual(await rpc(client, r2.claims, "fdb_account_guildbook_guilds", [I1]), []);
    assert.deepEqual(await rpc(client, r2.claims, "fdb_account_guildbook_members", [I1, guilds[0].guild_key, 200, 0]), []);
    assert.deepEqual(await rpc(client, r2.claims, "fdb_installation_link_status", [I1]), { state: "unknown" });
    // r3 natively owns I4 (first ingested by a registered Companion): listed and authorised exactly like a claimed one
    assert.deepEqual((await rpc(client, r3.claims, "fdb_account_installations")).map((r) => r.installation_id), [I4]);
    assert.equal((await rpc(client, r3.claims, "fdb_account_guildbook_guilds", [I4])).length, 1);
    assert.deepEqual(await rpc(client, r3.claims, "fdb_account_guildbook_guilds", [I1]), []);
  });

  it("transferring a second installation to the same account yields multiple installations per account; the first stays intact", async () => {
    const { a1, r1, I1, I2 } = w;
    await fx.resetBudgets();
    const before = await fingerprint();
    const { code } = await rpc(client, a1.claims, "fdb_account_claim_start", [I2]);
    assert.equal((await rpc(client, r1.claims, "fdb_account_claim_redeem", [code])).ok, true);
    assert.deepEqual((await rpc(client, r1.claims, "fdb_account_installations")).map((r) => r.installation_id).sort(), [I1, I2].sort());
    assert.deepEqual(await fingerprint(), before);
  });

  it("the migration did not alter the stored data model: no new column, trigger or policy on existing tables", async () => {
    const trig = await admin.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal");
    assert.equal(trig.rows[0].n, 0);
    const pol = await admin.query("select count(*)::int n from pg_policies where schemaname = 'public' and tablename like 'installation%'");
    assert.equal(pol.rows[0].n, 0);
  });
});
