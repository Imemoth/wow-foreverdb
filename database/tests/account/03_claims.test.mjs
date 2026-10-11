// Ownership claim protocol (ownership-claim-protocol.md sections 1-6) against real PostgreSQL + the real GoTrue auth schema.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fixtures, asUser, claimsFor, connect, expectCode, rpc, uniq } from "./harness.mjs";

const admin = await connect();
const client = await connect();
const fx = new Fixtures(admin);
after(async () => {
  await client.end();
  await admin.end();
});
beforeEach(() => fx.resetBudgets());

const INVALID = { ok: false, error: "invalid_claim" };
const NOT_AVAILABLE = { ok: false, error: "not_available" };
const start = (id, inst) => rpc(client, id.claims, "fdb_account_claim_start", [inst]);
const redeem = (id, code) => rpc(client, id.claims, "fdb_account_claim_redeem", [code]);
const status = (id, inst) => rpc(client, id.claims, "fdb_installation_link_status", [inst]);

async function ownerWithInstallation() {
  const owner = await fx.identity({ anonymous: true });
  const inst = uniq("claim-inst");
  await fx.installation(inst, owner.uid);
  return { owner, inst };
}

describe("claim start", () => {
  it("issues a 128-bit uppercase-hex code, stores only its sha256, binds uid + issuing session, expires in 10 minutes", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const r = await start(owner, inst);
    assert.equal(r.ok, true);
    assert.match(r.code, /^[0-9A-F]{32}$/);
    assert.deepEqual(Object.keys(r).sort(), ["code", "expires_at", "ok"]);
    const rows = await fx.claimRows(inst);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].initiator_uid, owner.uid);
    assert.equal(rows[0].initiator_session_id, owner.sid);
    const expected = await admin.query("select extensions.digest($1, 'sha256') as h", [r.code]);
    assert.deepEqual(rows[0].code_hash, expected.rows[0].h);
    const ttl = (new Date(rows[0].expires_at) - Date.now()) / 1000;
    assert.ok(ttl > 590 && ttl <= 600, `ttl ${ttl}`);
    assert.deepEqual((await fx.audit(inst)).map((a) => a.event), ["claim_started"]);
  });

  it("never persists the plaintext code anywhere in the private schema (claims, links, audit)", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const { code } = await start(owner, inst);
    await redeem(reg, code);
    await redeem(reg, code); // replay -> audit row
    for (const table of ["private.installation_claims", "private.account_installations", "private.account_audit"]) {
      const r = await admin.query(`select count(*)::int n from ${table} t where t::text ilike $1`, [`%${code}%`]);
      assert.equal(r.rows[0].n, 0, `${table} must not contain the code`);
    }
    const cols = await admin.query(
      `select column_name from information_schema.columns where table_schema = 'private' and table_name in ('installation_claims','account_audit','account_installations')`,
    );
    assert.ok(!cols.rows.some((c) => /code$|plain|token|email|ip/i.test(c.column_name) && c.column_name !== "code_hash"));
  });

  it("codes are unpredictable: 200 fresh codes are all distinct and use the whole hex alphabet", async () => {
    const owner = await fx.identity({ anonymous: true });
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const inst = uniq("entropy");
      await fx.installation(inst, owner.uid);
      const { rows } = await admin.query("select upper(encode(extensions.gen_random_bytes(16), 'hex')) as c");
      seen.add(rows[0].c);
    }
    assert.equal(seen.size, 200);
    assert.equal(new Set([...seen].join("")).size, 16);
  });

  it("only the CURRENT owner can issue; unknown, foreign and malformed ids give the SAME not_available result", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const other = await fx.identity({ anonymous: true });
    assert.deepEqual(await start(other, inst), NOT_AVAILABLE); // leaked installation id is useless
    assert.deepEqual(await start(other, "does-not-exist"), NOT_AVAILABLE);
    assert.deepEqual(await start(other, "bad id with spaces"), NOT_AVAILABLE);
    assert.deepEqual(await start(other, "x".repeat(129)), NOT_AVAILABLE);
    assert.deepEqual(await start(other, null), NOT_AVAILABLE);
    assert.equal((await fx.claimRows(inst)).length, 0);
    assert.equal((await start(owner, inst)).ok, true);
  });

  it("an ownerless installation cannot be claimed", async () => {
    const owner = await fx.identity({ anonymous: true });
    const inst = uniq("ownerless");
    await fx.installation(inst, null);
    assert.deepEqual(await start(owner, inst), NOT_AVAILABLE);
  });

  it("issues a single pending claim per installation; a new code revokes the previous one", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const first = await start(owner, inst);
    const second = await start(owner, inst);
    const rows = await fx.claimRows(inst);
    assert.deepEqual(rows.map((r) => r.status), ["revoked", "pending"]);
    assert.deepEqual((await fx.audit(inst)).map((a) => a.event), ["claim_started", "claim_revoked", "claim_started"]);
    assert.deepEqual(await redeem(reg, first.code), INVALID);
    assert.equal((await redeem(reg, second.code)).ok, true);
  });

  it("per-uid budget: the 4th start in a window is PT429 and writes nothing", async () => {
    const owner = await fx.identity({ anonymous: true });
    for (let i = 0; i < 3; i += 1) {
      const inst = uniq("budget");
      await fx.installation(inst, owner.uid);
      assert.equal((await start(owner, inst)).ok, true);
    }
    const inst = uniq("budget");
    await fx.installation(inst, owner.uid);
    await expectCode(start(owner, inst), "PT429");
    assert.equal((await fx.claimRows(inst)).length, 0);
  });

  it("per-installation budget is charged only AFTER the owner check (a stranger cannot exhaust the owner's budget)", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const stranger = await fx.identity({ anonymous: true });
    assert.deepEqual(await start(stranger, inst), NOT_AVAILABLE);
    assert.deepEqual(await start(stranger, inst), NOT_AVAILABLE);
    const keys = await admin.query("select bucket from private.foreverdb_api_budgets where bucket like 'claim_start:inst:%'");
    assert.equal(keys.rowCount, 0, "no per-installation budget row was created by a non-owner");
    assert.equal((await start(owner, inst)).ok, true);
    const after = await admin.query("select bucket, calls from private.foreverdb_api_budgets where bucket like 'claim_start:inst:%'");
    assert.equal(after.rowCount, 1);
    assert.match(after.rows[0].bucket, /^claim_start:inst:[0-9a-f]{32}$/);
  });

  it("an exhausted per-installation budget stops the owner (PT429) but is invisible to everybody else", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const stranger = await fx.identity({ anonymous: true });
    const key = (await admin.query("select 'claim_start:inst:' || substr(encode(extensions.digest($1, 'sha256'), 'hex'), 1, 32) as k", [inst])).rows[0].k;
    await admin.query("insert into private.foreverdb_api_budgets (bucket, window_started, calls) values ($1, to_timestamp(floor(extract(epoch from clock_timestamp()) / 300) * 300), 3)", [key]);
    await expectCode(start(owner, inst), "PT429");
    assert.deepEqual(await start(stranger, inst), NOT_AVAILABLE);
  });
});

describe("claim redeem", () => {
  it("transfers ownership atomically: owner_user_id, link row, consumed claim, audit; returns the contract shape", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const { code } = await start(owner, inst);
    const r = await redeem(reg, code);
    assert.deepEqual(Object.keys(r).sort(), ["installation_id", "linked_at", "ok"]);
    assert.equal(r.ok, true);
    assert.equal(r.installation_id, inst);
    assert.equal(await fx.owner(inst), reg.uid);
    const link = (await admin.query("select * from private.account_installations where installation_id = $1", [inst])).rows[0];
    assert.equal(link.account_uid, reg.uid);
    assert.equal(link.previous_owner_uid, owner.uid);
    const claim = (await fx.claimRows(inst))[0];
    assert.equal(link.claim_id, claim.id);
    assert.equal(claim.status, "consumed");
    assert.equal(claim.consumed_by, reg.uid);
    assert.ok(claim.consumed_at);
    assert.deepEqual((await fx.audit(inst)).map((a) => a.event), ["claim_started", "claim_redeemed"]);
  });

  it("is one-time: replay by the same account and by another account both get the indistinguishable failure", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const other = await fx.identity();
    const { code } = await start(owner, inst);
    assert.equal((await redeem(reg, code)).ok, true);
    assert.deepEqual(await redeem(reg, code), INVALID);
    assert.deepEqual(await redeem(other, code), INVALID);
    assert.equal(await fx.owner(inst), reg.uid);
    assert.equal((await fx.claimRows(inst))[0].status, "consumed", "a replay never un-consumes or revokes a consumed claim");
  });

  it("one indistinguishable failure for wrong, malformed, expired, revoked, consumed and owner-mismatch codes", async () => {
    const reg = await fx.identity();
    const results = [];
    results.push(await redeem(reg, "0".repeat(32))); // not found
    results.push(await redeem(reg, "xyz")); // malformed
    results.push(await redeem(reg, "a".repeat(32))); // lowercase is not canonical
    results.push(await redeem(reg, null));
    { // expired
      const { owner, inst } = await ownerWithInstallation();
      const { code } = await start(owner, inst);
      await admin.query("update private.installation_claims set expires_at = now() - interval '1 second' where installation_id = $1", [inst]);
      results.push(await redeem(reg, code));
    }
    { // revoked
      const { owner, inst } = await ownerWithInstallation();
      const { code } = await start(owner, inst);
      await start(owner, inst);
      results.push(await redeem(reg, code));
    }
    { // owner changed while the claim was pending
      const { owner, inst } = await ownerWithInstallation();
      const { code } = await start(owner, inst);
      await admin.query("update public.installations set owner_user_id = $2 where id = $1", [inst, (await fx.identity({ anonymous: true })).uid]);
      results.push(await redeem(reg, code));
    }
    { // unknown installation (deleted after the claim)
      const { owner, inst } = await ownerWithInstallation();
      const { code } = await start(owner, inst);
      await admin.query("delete from public.installations where id = $1", [inst]);
      results.push(await redeem(reg, code));
    }
    for (const r of results) assert.deepEqual(r, INVALID);
    assert.equal(new Set(results.map((r) => JSON.stringify(r))).size, 1);
  });

  it("wrong-code guessing is throttled per redeemer: the 11th attempt in a window is PT429 (counters persist across failures)", async () => {
    const reg = await fx.identity();
    for (let i = 0; i < 10; i += 1) assert.deepEqual(await redeem(reg, i.toString(16).padStart(32, "0").toUpperCase()), INVALID);
    await expectCode(redeem(reg, "F".repeat(32)), "PT429");
    const n = await admin.query("select calls from private.foreverdb_api_budgets where bucket = $1", [`claim_redeem:uid:${reg.uid}`]);
    assert.equal(n.rows[0].calls, 10, "the failed attempts were persisted, not rolled back");
  });

  it("an owner that upgraded itself to a permanent account between start and redeem cannot be moved by a leaked code", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const { code } = await start(owner, inst);
    await admin.query("update auth.users set is_anonymous = false, email = 'up-' || id || '@example.invalid', email_confirmed_at = now() where id = $1", [owner.uid]);
    assert.deepEqual(await redeem(reg, code), INVALID);
    assert.equal(await fx.owner(inst), owner.uid);
  });

  it("the initiator itself (same uid) cannot redeem its own code", async () => {
    const owner = await fx.identity({ anonymous: true });
    const inst = uniq("self");
    await fx.installation(inst, owner.uid);
    const { code } = await start(owner, inst);
    // the owner upgrades in place and then tries to redeem its own code
    await admin.query("update auth.users set is_anonymous = false, email = 'self-' || id || '@example.invalid', email_confirmed_at = now() where id = $1", [owner.uid]);
    assert.deepEqual(await redeem(owner, code), INVALID);
  });

  it("account limit: a valid code is NOT consumed when the account already owns 50 installations", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    for (let i = 0; i < 50; i += 1) await fx.installation(uniq("full"), reg.uid);
    const { code } = await start(owner, inst);
    assert.deepEqual(await redeem(reg, code), { ok: false, error: "account_limit" });
    assert.equal(await fx.owner(inst), owner.uid);
    assert.equal((await fx.claimRows(inst))[0].status, "pending");
    await admin.query("delete from public.installations where owner_user_id = $1 and id in (select id from public.installations where owner_user_id = $1 limit 1)", [reg.uid]);
    assert.equal((await redeem(reg, code)).ok, true);
  });

  it("5 failed re-validations revoke the claim (it stops being redeemable even when the problem disappears)", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const { code } = await start(owner, inst);
    await admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [owner.uid]);
    for (let i = 0; i < 5; i += 1) assert.deepEqual(await redeem(reg, code), INVALID);
    const claim = (await fx.claimRows(inst))[0];
    assert.equal(claim.status, "revoked");
    assert.equal(claim.attempts, 5);
    await admin.query("update auth.users set banned_until = null where id = $1", [owner.uid]);
    assert.deepEqual(await redeem(reg, code), INVALID);
    assert.ok((await fx.audit(inst)).some((a) => a.event === "claim_revoked"));
  });

  describe("LS-6 / LS-7: sessions", () => {
    it("LS-6: a revoked registered token cannot redeem; the claim stays pending and ownership is unchanged", async () => {
      const { owner, inst } = await ownerWithInstallation();
      const reg = await fx.identity();
      const { code } = await start(owner, inst);
      await admin.query("delete from auth.sessions where id = $1", [reg.sid]);
      await expectCode(redeem(reg, code), "PT401");
      const claim = (await fx.claimRows(inst))[0];
      assert.equal(claim.status, "pending");
      assert.equal(claim.attempts, 0);
      assert.equal(await fx.owner(inst), owner.uid);
    });

    it("LS-7: revoking ONLY the issuing session cancels the claim even though another, older session of the same user is alive", async () => {
      const owner = await fx.identity({ anonymous: true });
      const olderSid = await fx.session(owner.uid); // a second live session, created before the issuing one is used
      const inst = uniq("ls7");
      await fx.installation(inst, owner.uid);
      const reg = await fx.identity();
      const { code } = await start(owner, inst);
      await admin.query("delete from auth.sessions where id = $1", [owner.sid]);
      const stillAlive = await admin.query("select 1 from auth.sessions where id = $1", [olderSid]);
      assert.equal(stillAlive.rowCount, 1);
      assert.deepEqual(await redeem(reg, code), INVALID);
      assert.equal((await fx.claimRows(inst))[0].status, "pending", "not consumed");
      assert.equal(await fx.owner(inst), owner.uid);
    });

    it("LS-7: a banned, soft-deleted or deleted initiator cancels the claim", async () => {
      for (const mutate of [
        (uid) => admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [uid]),
        (uid) => admin.query("update auth.users set deleted_at = now() where id = $1", [uid]),
        (uid) => admin.query("delete from auth.users where id = $1", [uid]),
        (uid) => admin.query("update auth.sessions set not_after = now() - interval '1 second' where user_id = $1", [uid]),
      ]) {
        const { owner, inst } = await ownerWithInstallation();
        const reg = await fx.identity();
        const { code } = await start(owner, inst);
        await mutate(owner.uid);
        assert.deepEqual(await redeem(reg, code), INVALID);
        assert.equal((await fx.claimRows(inst))[0].status, "pending");
        assert.equal(await fx.owner(inst), owner.uid);
      }
    });

    it("a redeemer whose email is unconfirmed, or who is anonymous, can never redeem", async () => {
      const { owner, inst } = await ownerWithInstallation();
      const { code } = await start(owner, inst);
      await expectCode(redeem(await fx.identity({ confirmed: false }), code), "PT403");
      await expectCode(redeem(await fx.identity({ anonymous: true }), code), "PT403");
      assert.equal((await fx.claimRows(inst))[0].status, "pending");
    });

    it("a destination account id can never be supplied: the signature has no such parameter", async () => {
      const r = await admin.query(`select pg_get_function_identity_arguments(p.oid) a from pg_proc p where proname = 'fdb_account_claim_redeem'`);
      assert.deepEqual(r.rows.map((x) => x.a), ["p_code text"]);
      await expectCode(rpc(client, (await fx.identity()).claims, "fdb_account_claim_redeem", ["0".repeat(32), "00000000-0000-0000-0000-000000000000"]), "42883");
    });
  });
});

describe("link status", () => {
  it("owned / transferred / unknown are shown only to the right identity, with one shape", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    const bystander = await fx.identity({ anonymous: true });
    const bystanderReg = await fx.identity();
    assert.deepEqual(await status(owner, inst), { state: "owned" });
    assert.deepEqual(await status(bystander, inst), { state: "unknown" });
    const { code } = await start(owner, inst);
    assert.equal((await redeem(reg, code)).ok, true);
    assert.deepEqual(await status(reg, inst), { state: "owned" });
    assert.deepEqual(await status(owner, inst), { state: "transferred" }); // the previous owner learns it
    assert.deepEqual(await status(bystander, inst), { state: "unknown" });
    assert.deepEqual(await status(bystanderReg, inst), { state: "unknown" });
    assert.deepEqual(await status(owner, "no-such-installation"), { state: "unknown" });
    assert.deepEqual(await status(owner, "bad id"), { state: "unknown" });
  });

  it("the transferred signal survives a pruned claim table (derived from the link row, no expiry)", async () => {
    const { owner, inst } = await ownerWithInstallation();
    const reg = await fx.identity();
    await redeem(reg, (await start(owner, inst)).code);
    await admin.query("update private.installation_claims set created_at = now() - interval '400 days', expires_at = now() - interval '400 days'");
    await admin.query("delete from private.account_audit where at < now()");
    assert.deepEqual(await status(owner, inst), { state: "transferred" });
  });

  it("is gated by the existing read budget (no new quota): the 'detail' bucket is charged", async () => {
    const { owner, inst } = await ownerWithInstallation();
    await status(owner, inst);
    const r = await admin.query("select calls from private.foreverdb_api_budgets where bucket = $1", [`detail:uid:${owner.uid}`]);
    assert.equal(r.rows[0].calls, 1);
  });
});

describe("account installation listing", () => {
  it("lists exactly the caller's installations (claimed and natively owned), bounded to 50, contract columns only", async () => {
    const reg = await fx.identity();
    const other = await fx.identity();
    const claimed = [];
    for (let i = 0; i < 2; i += 1) {
      const { owner, inst } = await ownerWithInstallation();
      await redeem(reg, (await start(owner, inst)).code);
      claimed.push(inst);
    }
    const native = uniq("native");
    await fx.installation(native, reg.uid);
    await fx.guild(native, "Realm:Guild1", [{ guid: "G1", name: "Alpha" }]);
    await fx.installation(uniq("foreign"), other.uid);
    const rows = await rpc(client, reg.claims, "fdb_account_installations");
    assert.deepEqual(rows.map((r) => r.installation_id).sort(), [...claimed, native].sort());
    for (const r of rows) assert.deepEqual(Object.keys(r).sort(), ["guild_count", "installation_id", "last_seen_at", "linked_at"]);
    assert.equal(rows.find((r) => r.installation_id === native).guild_count, 1);
    const link = (await admin.query("select linked_at from private.account_installations where installation_id = $1", [claimed[0]])).rows[0];
    assert.equal(new Date(rows.find((r) => r.installation_id === claimed[0]).linked_at).getTime(), new Date(link.linked_at).getTime());
    assert.deepEqual(await rpc(client, other.claims, "fdb_account_installations").then((r) => r.length), 1);
  });

  it("is bounded to 50 rows", async () => {
    const reg = await fx.identity();
    for (let i = 0; i < 55; i += 1) await fx.installation(uniq("many"), reg.uid);
    assert.equal((await rpc(client, reg.claims, "fdb_account_installations")).length, 50);
  });

  it("returns nothing to a registered user that owns nothing (and cannot be used to enumerate others)", async () => {
    const reg = await fx.identity();
    await ownerWithInstallation();
    assert.deepEqual(await rpc(client, reg.claims, "fdb_account_installations"), []);
  });
});

describe("private Guildbook", () => {
  async function owned() {
    const reg = await fx.identity();
    const inst = uniq("gb");
    await fx.installation(inst, reg.uid);
    const members = [];
    for (let i = 0; i < 12; i += 1) members.push({ guid: `Player-0-${i}`, name: `Member${String(i).padStart(2, "0")}`, rankIndex: i < 2 ? 0 : 3, rank: i < 2 ? "Officer" : "Member" });
    await fx.guild(inst, "Realm:Guild1", members);
    await fx.guild(inst, "Realm:Guild2", [{ guid: "Player-9-1", name: "Solo" }]);
    return { reg, inst };
  }

  it("returns the owner's guilds and members with exactly the contract columns (no member_guid / installation_id)", async () => {
    const { reg, inst } = await owned();
    const guilds = await rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst]);
    assert.deepEqual(guilds.map((g) => [g.guild_key, g.member_count]), [["Realm:Guild1", 12], ["Realm:Guild2", 1]]);
    for (const g of guilds) assert.deepEqual(Object.keys(g).sort(), ["captured_at", "guild_key", "guild_name", "member_count", "realm_name"]);
    const members = await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 200, 0]);
    assert.equal(members.length, 12);
    for (const m of members) assert.deepEqual(Object.keys(m).sort(), ["class_file", "class_name", "last_online_hours", "level", "member_name", "online", "rank_index", "rank_name", "zone_name"]);
    assert.ok(!JSON.stringify(members).includes("Player-0-"), "no GUID leaks");
  });

  it("orders by (rank_index, member_name), pages with offset, and clamps limit to 1..200 and offset to 0..100000", async () => {
    const { reg, inst } = await owned();
    const all = await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 200, 0]);
    const sorted = [...all].sort((a, b) => a.rank_index - b.rank_index || (a.member_name < b.member_name ? -1 : 1));
    assert.deepEqual(all, sorted);
    const page = await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 5, 5]);
    assert.deepEqual(page, all.slice(5, 10));
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 0, 0])).length, 1, "limit clamped up to 1");
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", -5, 0])).length, 1);
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 100000, 0])).length, 12, "limit clamped down to 200");
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 10, 1000000])).length, 0, "offset clamped, not an error");
    assert.deepEqual(await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Guild1", 10, -3]), all.slice(0, 10), "negative offset clamped to 0");
  });

  it("response size is bounded: a 230-member guild never returns more than 200 rows, however large the requested limit", async () => {
    const reg = await fx.identity();
    const inst = uniq("big");
    await fx.installation(inst, reg.uid);
    await admin.query("insert into public.installation_guilds (installation_id, guild_key, guild_name, realm_name, captured_at) values ($1, 'Realm:Big', 'Big', 'Realm', 1)", [inst]);
    await admin.query(
      `insert into public.installation_guild_members (installation_id, guild_key, member_guid, member_name, rank_index)
       select $1, 'Realm:Big', 'Player-' || g, 'Name' || lpad(g::text, 4, '0'), g % 5 from generate_series(1, 230) g`,
      [inst],
    );
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Big", 100000, 0])).length, 200);
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Big", 200, 200])).length, 30);
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "Realm:Big", null, null])).length, 100, "defaults apply to NULL");
    const guilds = await rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst]);
    assert.equal(guilds[0].member_count, 230);
  });

  it("a non-owner (another registered account) gets an EMPTY result, indistinguishable from owned-but-empty, for every client-supplied id", async () => {
    const { inst } = await owned();
    const intruder = await fx.identity();
    const emptyOwn = uniq("empty");
    await fx.installation(emptyOwn, intruder.uid);
    for (const id of [inst, "no-such-installation", emptyOwn]) {
      assert.deepEqual(await rpc(client, intruder.claims, "fdb_account_guildbook_guilds", [id]), []);
      assert.deepEqual(await rpc(client, intruder.claims, "fdb_account_guildbook_members", [id, "Realm:Guild1", 100, 0]), []);
    }
    assert.deepEqual((await rpc(client, intruder.claims, "fdb_account_installations")).map((r) => r.installation_id), [emptyOwn]);
  });

  it("an installation id and a guild key owned by DIFFERENT accounts cannot be combined (guild key is scoped by installation)", async () => {
    const a = await owned();
    const b = await owned();
    assert.deepEqual(await rpc(client, a.reg.claims, "fdb_account_guildbook_members", [b.inst, "Realm:Guild1", 100, 0]), []);
    assert.equal((await rpc(client, a.reg.claims, "fdb_account_guildbook_members", [a.inst, "Realm:Guild1", 100, 0])).length, 12);
  });

  it("after a transfer the previous anonymous owner has no Guildbook access and the new owner has it", async () => {
    const { owner, inst } = await ownerWithInstallation();
    await fx.guild(inst, "Realm:Guild1", [{ guid: "P1", name: "Alpha" }]);
    const reg = await fx.identity();
    assert.deepEqual(await rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst]), []);
    await redeem(reg, (await start(owner, inst)).code);
    assert.equal((await rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst])).length, 1);
    await expectCode(rpc(client, owner.claims, "fdb_account_guildbook_guilds", [inst]), "PT403");
  });

  it("malformed ids and keys are PT400 (not a data oracle); the existing 'detail' read budget applies", async () => {
    const { reg, inst } = await owned();
    await expectCode(rpc(client, reg.claims, "fdb_account_guildbook_guilds", ["bad id"]), "PT400");
    await expectCode(rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "", 10, 0]), "PT400");
    await expectCode(rpc(client, reg.claims, "fdb_account_guildbook_members", [inst, "k".repeat(201), 10, 0]), "PT400");
    for (let i = 0; i < 65; i += 1) await rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst]); // detail budget: 65 per 60 s
    await expectCode(rpc(client, reg.claims, "fdb_account_guildbook_guilds", [inst]), "PT429");
  });

  it("direct table access stays revoked for every API role", async () => {
    const { reg } = await owned();
    for (const table of ["installation_guilds", "installation_guild_members", "installation_guild_professions", "installations", "installation_item_stats"]) {
      await expectCode(asUser(client, reg.claims, (q) => q(`select * from public.${table} limit 1`)), "42501");
      await expectCode(asUser(client, reg.claims, (q) => q(`select * from public.${table} limit 1`), { role: "anon" }), "42501");
    }
    for (const table of ["installation_claims", "account_installations", "account_audit"]) {
      await expectCode(asUser(client, reg.claims, (q) => q(`select * from private.${table} limit 1`)), "42501");
    }
  });
});
