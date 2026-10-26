// The pre-existing SQL regression files run by .github/workflows/api-security.yml (API security roles/quotas, F-3 denominator round trip) must still pass AFTER 0012 on the same
// database, i.e. the account migration did not regress ingest, search, statistics or quota gates. They run on a throw-away clone because
// the F-3 test temporarily swaps function bodies (it restores them exactly).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DB, HOST, PORT, connectSuper, repoRoot } from "./harness.mjs";

const CLONE = `${DB}_reg`;
const run = (file) => {
  const r = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", "fdb_migrator", "-d", CLONE, "-f", path.join(repoRoot, file)], {
    env: { ...process.env, PGPASSWORD: "local-test-password" },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

before(async () => {
  const sup = await connectSuper("postgres");
  await sup.query(`drop database if exists ${CLONE} with (force)`);
  for (let i = 0; i < 10; i += 1) {
    await sup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [DB]);
    try {
      await sup.query(`create database ${CLONE} template ${DB}`);
      break;
    } catch (e) {
      if (!/being accessed/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  await sup.end();
});
after(async () => {
  const sup = await connectSuper("postgres");
  await sup.query(`drop database if exists ${CLONE} with (force)`);
  await sup.end();
});

describe("existing regression suites after 0012", () => {
  for (const file of [
    "database/tests/api_security_roles_and_quotas.sql",
    "database/tests/f3_drop_rate_denominator.sql",
  ]) {
    it(`${path.basename(file)} passes on the migrated database`, () => {
      const r = run(file);
      assert.equal(r.status, 0, r.out.slice(-2000));
    });
  }
});
