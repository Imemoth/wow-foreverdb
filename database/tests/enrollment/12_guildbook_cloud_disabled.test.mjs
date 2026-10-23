// Migration 0018: existing Guildbook rows and function definitions remain,
// but no API role can invoke the old cloud ingest/read paths.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, expectCode } from "./world.mjs";

const w = await makeWorld();
after(() => w.close());

const RPCS = [
  "public.fdb_account_guildbook_guilds(text)",
  "public.fdb_account_guildbook_members(text,text,integer,integer)",
  "public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)",
  "public.fdb_account_guildbook_guilds_scoped(text)",
  "public.fdb_account_guildbook_members_scoped(text,text,integer,integer)",
];

describe("Guildbook local-only kill switch", () => {
  it("retains definitions and data but revokes every client EXECUTE grant", async () => {
    for (const sig of RPCS) {
      const row = (await w.admin.query("select to_regprocedure($1) is not null as exists, has_function_privilege('public', $1, 'execute') as public, has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as authenticated, has_function_privilege('service_role', $1, 'execute') as service", [sig])).rows[0];
      assert.equal(row.exists, true, sig);
      assert.equal(row.public, false, sig);
      assert.equal(row.anon, false, sig);
      assert.equal(row.authenticated, false, sig);
      assert.equal(row.service, false, sig);
    }
    assert.equal((await w.row("select count(*)::int as n from public.installation_guilds"))[0].n >= 0, true);
    assert.equal((await w.row("select count(*)::int as n from private.account_guildbook_captures"))[0].n >= 0, true);
  });

  it("a real registered session cannot call a legacy Guildbook RPC after the migration", async () => {
    const account = await w.account();
    await expectCode(account.call("fdb_account_guildbook_guilds", ["missing-installation"]), "42501");
    await expectCode(account.call("fdb_account_guildbook_guilds_scoped", ["missing-installation"]), "42501");
  });
});
