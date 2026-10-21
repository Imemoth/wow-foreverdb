// LS-1 .. LS-8 (and the guard-kind checks): every account function installed by migration 0012 enforces a LIVE Auth
// session, against the REAL GoTrue auth.users / auth.sessions tables. Later account RPC families are exercised by the
// migration-specific suites after their migrations have been applied.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Fixtures, claimsFor, connect, expectCode, repoRoot, rpc, uniq } from "./harness.mjs";

const admin = await connect();
const client = await connect();
const fx = new Fixtures(admin);
after(async () => {
  await client.end();
  await admin.end();
});
beforeEach(() => fx.resetBudgets());

// --- registry, parsed from the PR A contract (single source of truth) ---------------------------------------------------
const contracts = fs.readFileSync(path.join(repoRoot, "web/src/lib/account/contracts.ts"), "utf8");
const guardBlock = /export const ACCOUNT_RPC_GUARDS[^=]*=\s*\{([\s\S]*?)\};/.exec(contracts)?.[1] ?? "";
const MIGRATION_0012_RPCS = new Set([
  "fdb_account_claim_start",
  "fdb_account_claim_redeem",
  "fdb_installation_link_status",
  "fdb_account_installations",
  "fdb_account_guildbook_guilds",
  "fdb_account_guildbook_members",
]);
const REGISTRY = Object.fromEntries(
  [...guardBlock.matchAll(/(\w+):\s*"(\w+)"/g)]
    .filter((m) => MIGRATION_0012_RPCS.has(m[1]))
    .map((m) => [m[1], m[2]]),
);

// Call shape for the migration-0012 function family. The keys are asserted equal to the filtered registry.
const CALLS = {
  fdb_account_claim_start: (inst) => [inst],
  fdb_account_claim_redeem: () => ["A".repeat(32)],
  fdb_installation_link_status: (inst) => [inst],
  fdb_account_installations: () => [],
  fdb_account_guildbook_guilds: (inst) => [inst],
  fdb_account_guildbook_members: (inst) => [inst, "Realm:Guild1", 10, 0],
};
const callerKind = (guard) => (guard === "registered_live_session" ? "registered" : "anonymous");

describe("LS-8 registry coverage", () => {
  it("the harness covers exactly the registered account functions, and the database has exactly those", async () => {
    assert.deepEqual(Object.keys(REGISTRY).sort(), Object.keys(CALLS).sort());
    const { rows } = await admin.query(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ '^fdb_(account_|installation_)' order by 1`,
    );
    assert.deepEqual(rows.map((r) => r.proname).sort(), Object.keys(REGISTRY).sort());
  });
});

async function caller(kind) {
  const id = await fx.identity({ anonymous: kind === "anonymous" });
  const inst = uniq("ls-inst");
  // An installation the caller owns, so a refusal is about the SESSION and not about ownership.
  await fx.installation(inst, id.uid);
  return { ...id, inst };
}

for (const [fn, guard] of Object.entries(REGISTRY)) {
  describe(`${fn} (${guard})`, () => {
    const kind = callerKind(guard);
    const call = (c, claims) => rpc(client, claims ?? c.claims, fn, CALLS[fn](c.inst));

    it("sanity: the same caller with a live session is NOT refused with PT401", async () => {
      const c = await caller(kind);
      await call(c); // must not throw
    });

    it("LS-1: revoked-but-unexpired token (session row deleted, claims and exp unchanged) is refused with PT401", async () => {
      const c = await caller(kind);
      await admin.query("delete from auth.sessions where id = $1", [c.sid]);
      await expectCode(call(c), "PT401");
      if (fn === "fdb_account_claim_start") {
        assert.equal((await fx.claimRows(c.inst)).length, 0, "no claim row");
        assert.equal((await fx.audit(c.inst)).length, 0, "no audit row");
        const b = await admin.query("select count(*)::int n from private.foreverdb_api_budgets where bucket like $1", [`%${c.uid}%`]);
        assert.equal(b.rows[0].n, 0, "no budget side effect");
        assert.equal(await fx.owner(c.inst), c.uid, "ownership unchanged");
      }
    });

    it("LS-1b: a session whose refresh tokens were all revoked (GoTrue reuse detection leaves the session row) is refused with PT401", async () => {
      const c = await caller(kind);
      await admin.query("update auth.refresh_tokens set revoked = true where session_id = $1", [c.sid]);
      assert.equal((await admin.query("select 1 from auth.sessions where id = $1", [c.sid])).rowCount, 1, "the session row is still there");
      await expectCode(call(c), "PT401");
    });

    it("LS-2: a token without a session_id claim is refused with PT401", async () => {
      const c = await caller(kind);
      await expectCode(call(c, claimsFor({ uid: c.uid, sid: c.sid, anonymous: kind === "anonymous", omit: ["session_id"] })), "PT401");
    });

    it("LS-2b: a malformed session_id is refused with PT401 (never a cast error)", async () => {
      const c = await caller(kind);
      for (const sid of ["not-a-uuid", "", "00000000-0000-0000-0000-00000000000", `${c.sid}'; select 1`, c.sid.toUpperCase().slice(0, 35), 12345]) {
        await expectCode(call(c, { ...c.claims, session_id: sid }), "PT401");
      }
    });

    it("LS-3: another user's live session id is refused with PT401", async () => {
      const a = await caller(kind);
      const b = await fx.identity({ anonymous: kind === "anonymous" });
      await expectCode(call(a, { ...a.claims, session_id: b.sid }), "PT401");
    });

    it("LS-4: an expired session (not_after in the past) is refused with PT401", async () => {
      const c = await caller(kind);
      await admin.query("update auth.sessions set not_after = now() - interval '1 minute' where id = $1", [c.sid]);
      await expectCode(call(c), "PT401");
    });

    it("LS-5: a soft-deleted user with a still-present session row is refused with PT401", async () => {
      const c = await caller(kind);
      await admin.query("update auth.users set deleted_at = now() where id = $1", [c.uid]);
      await expectCode(call(c), "PT401");
    });

    it("LS-5: a banned user with a still-present session row is refused with PT401", async () => {
      const c = await caller(kind);
      await admin.query("update auth.users set banned_until = now() + interval '1 hour' where id = $1", [c.uid]);
      await expectCode(call(c), "PT401");
      await admin.query("update auth.users set banned_until = now() - interval '1 hour' where id = $1", [c.uid]);
      await call(c); // an expired ban no longer blocks
    });

    it("a non-authenticated role claim is refused with PT401", async () => {
      const c = await caller(kind);
      await expectCode(call(c, { ...c.claims, role: "anon" }), "PT401");
      await expectCode(call(c, { ...c.claims, role: "service_role" }), "PT401");
    });

    it("a token whose sub is missing is refused with PT401", async () => {
      const c = await caller(kind);
      await expectCode(call(c, claimsFor({ uid: c.uid, sid: c.sid, omit: ["sub"] })), "PT401");
    });

    if (guard === "registered_live_session") {
      it("an anonymous identity with a live session is refused with PT403", async () => {
        const c = await caller("anonymous");
        await expectCode(call(c), "PT403");
      });
      it("a registered user whose email is NOT confirmed is refused with PT403", async () => {
        const c = await fx.identity({ confirmed: false });
        await expectCode(rpc(client, c.claims, fn, CALLS[fn]("whatever-inst")), "PT403");
      });
      it("a user whose email confirmation is removed after the session was issued is refused with PT403", async () => {
        const c = await caller("registered");
        await admin.query("update auth.users set email_confirmed_at = null where id = $1", [c.uid]);
        await expectCode(call(c), "PT403");
      });
    }
    if (guard === "anonymous_owner_live_session") {
      it("a registered identity with a live session is refused with PT403", async () => {
        const c = await caller("registered");
        await expectCode(call(c), "PT403");
      });
    }
  });
}

describe("guards are not reachable by clients and cannot be satisfied by claims alone", () => {
  it("authenticated/anon cannot call the private guards or touch the private tables or schema", async () => {
    const c = await fx.identity();
    for (const g of ["private.fdb_caller()", "private.fdb_anonymous_caller()", "private.fdb_registered_caller()"]) {
      for (const role of ["authenticated", "anon"]) {
        await expectCode(
          (async () => {
            await client.query("begin");
            try {
              await client.query(`set local role ${role}`);
              await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(c.claims)]);
              await client.query(`select ${g}`);
            } finally {
              await client.query("rollback");
            }
          })(),
          "42501",
        );
      }
    }
  });

  it("a session row that exists for the uid but with a different session id in the token is refused (no 'any session of the user')", async () => {
    const c = await fx.identity();
    await fx.session(c.uid); // a second live session for the same user
    await expectCode(rpc(client, { ...c.claims, session_id: crypto.randomUUID() }, "fdb_installation_link_status", ["x"]), "PT401");
  });
});
