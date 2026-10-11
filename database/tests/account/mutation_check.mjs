// Mutation check: proves the suite CAN fail. Each mutation weakens one security property in a copy of migration 0012, applies it to a
// throw-away clone of the integration database, and runs the relevant test files against the clone. Every mutant must be KILLED
// (at least one test fails). A surviving mutant means a missing test. Not part of the PR gate (slow); run before review:
//   PGUSER=... PGPASSWORD=... node database/tests/account/mutation_check.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DB, HOST, PORT, connectSuper, repoRoot } from "./harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const original = fs.readFileSync(path.join(repoRoot, "database/migrations/0012_account_ownership_claims.sql"), "utf8");
const CLONE = `${DB}_mut`;

const GUARD_BLOCK = /    if not exists \(\s*select 1\s*from auth\.sessions s\s*join auth\.users u on u\.id = s\.user_id\s*where s\.id = v_sid::uuid[\s\S]*?end if;\n/;
const mutants = [
  ["guard: no live-session check at all", (s) => s.replace(GUARD_BLOCK, ""), ["02_live_session.test.mjs"]],
  ["guard: ignores session not_after", (s) => s.replace("          and (s.not_after is null or s.not_after > now())\n          and exists (select 1 from auth.refresh_tokens", "          and exists (select 1 from auth.refresh_tokens"), ["02_live_session.test.mjs"]],
  ["guard: ignores banned_until", (s) => s.replace("          and (u.banned_until is null or u.banned_until <= now())\n    ) then", "    ) then"), ["02_live_session.test.mjs"]],
  ["guard: ignores deleted_at", (s) => s.replace("          and u.deleted_at is null\n          and (u.banned_until", "          and (u.banned_until"), ["02_live_session.test.mjs"]],
  ["guard: session of ANY user accepted (user_id not compared)", (s) => s.replace("          and s.user_id = v_uid\n          and (s.not_after", "          and (s.not_after"), ["02_live_session.test.mjs"]],
  ["guard: refresh-token liveness not required (reuse-detection revoked session accepted)", (s) => s.replace("          and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not r.revoked)\n          and u.deleted_at is null\n          and (u.banned_until", "          and u.deleted_at is null\n          and (u.banned_until"), ["02_live_session.test.mjs"]],
  ["claim_redeem: per-account lock removed (cap race)", (s) => s.replace("    perform pg_advisory_xact_lock(hashtextextended('fdb-account:' || v_uid::text, 0));\n", ""), ["04_concurrency.test.mjs"]],
  ["claim_redeem: global budget charged BEFORE the installation lock (stall)", (s) => s.replace("    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));\n    perform private.foreverdb_take_budget('claim_redeem:global', 300, 120);\n", "    perform private.foreverdb_take_budget('claim_redeem:global', 300, 120);\n    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));\n"), ["04_concurrency.test.mjs"]],
  ["claim_redeem: stale link row raises a raw error", (s) => s.replace("    on conflict (installation_id) do nothing\n", ""), ["03_claims.test.mjs"]],
  ["registered guard: email confirmation not required", (s) => s.replace("where u.id = v_uid and not u.is_anonymous and u.email_confirmed_at is not null", "where u.id = v_uid and not u.is_anonymous"), ["02_live_session.test.mjs"]],
  ["anonymous guard: registered users accepted", (s) => s.replace("select 1 from auth.users u where u.id = v_uid and u.is_anonymous\n", "select 1 from auth.users u where u.id = v_uid\n"), ["02_live_session.test.mjs"]],
  ["claim_start: no owner check", (s) => s.replace("    if not found or v_owner is distinct from v_uid then\n        return jsonb_build_object('ok', false, 'error', 'not_available');", "    if not found then\n        return jsonb_build_object('ok', false, 'error', 'not_available');"), ["03_claims.test.mjs"]],
  ["claim_start: re-verification after the advisory lock removed", (s) => s.replace(/    perform 1\n    from auth\.sessions s\n    join auth\.users u on u\.id = s\.user_id\n    where s\.id = v_sid and s\.user_id = v_uid\n      and \(s\.not_after is null or s\.not_after > now\(\)\)\n      and exists \(select 1 from auth\.refresh_tokens r where r\.session_id = s\.id and not r\.revoked\)\n      and u\.deleted_at is null and \(u\.banned_until is null or u\.banned_until <= now\(\)\)\n      and u\.is_anonymous\n    for share of s;\n    if not found then\n        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';\n    end if;\n/, ""), ["04_concurrency.test.mjs"]],
  ["claim_start: re-verification without the FOR SHARE row lock", (s) => s.replace("      and u.is_anonymous\n    for share of s;", "      and u.is_anonymous;"), ["04_concurrency.test.mjs"]],
  ["claim_redeem: any live session of the initiator keeps the claim alive", (s) => s.replace("where s.id = v_initiator_sid and s.user_id = v_initiator", "where s.user_id = v_initiator"), ["03_claims.test.mjs"]],
  ["claim_redeem: issuing session not checked", (s) => s.replace(/    if v_valid then\n        -- The EXACT session[\s\S]*?v_valid := found;\n    end if;\n/, ""), ["03_claims.test.mjs"]],
  ["claim_redeem: initiator may have upgraded to a registered account", (s) => s.replace("where u.id = v_initiator and u.is_anonymous\n", "where u.id = v_initiator\n"), ["03_claims.test.mjs"]],
  ["claim_redeem: claim never marked consumed (replay)", (s) => s.replace("    set status = 'consumed', consumed_at = clock_timestamp(), consumed_by = v_uid\n", "    set consumed_at = clock_timestamp(), consumed_by = v_uid\n"), ["03_claims.test.mjs"]],
  ["claim_redeem: expiry ignored", (s) => s.replace("and v_expires > clock_timestamp()", ""), ["03_claims.test.mjs"]],
  ["claim_redeem: failure attempts never counted/revoked", (s) => s.replace("            set attempts = attempts + 1,\n                status = case when attempts + 1 >= 5 then 'revoked' else status end", "            set attempts = attempts"), ["03_claims.test.mjs"]],
  ["claim_redeem: account limit consumes/ignored", (s) => s.replace("if v_owned >= 50 then", "if v_owned >= 5000 then"), ["03_claims.test.mjs"]],
  ["link_status: any caller learns 'transferred'", (s) => s.replace("l.installation_id = p_installation_id and l.previous_owner_uid = v_uid", "l.installation_id = p_installation_id"), ["03_claims.test.mjs"]],
  ["guildbook members: ownership not re-derived", (s) => s.replace("      and m.guild_key = p_guild_key\n      and i.owner_user_id = v_uid\n", "      and m.guild_key = p_guild_key\n"), ["03_claims.test.mjs"]],
  ["guildbook guilds: ownership not re-derived", (s) => s.replace("      and i.owner_user_id = v_uid\n    order by g.guild_name", "    order by g.guild_name"), ["03_claims.test.mjs"]],
  ["installations: other accounts' installations listed", (s) => s.replace("    where i.owner_user_id = v_uid\n    order by i.last_seen_at", "    order by i.last_seen_at"), ["03_claims.test.mjs"]],
  ["guildbook members: limit not clamped to 200", (s) => s.replace("least(coalesce(p_limit, 100), 200)", "coalesce(p_limit, 100)"), ["03_claims.test.mjs"]],
  ["claim_start: per-installation budget charged BEFORE the owner check", (s) => {
    const budget = /    -- Only now \(the caller proved ownership\)[\s\S]*?300, 3\);\n\n/.exec(s)[0];
    return s.replace(budget, "").replace("    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));\n", `    perform private.foreverdb_take_budget('claim_start:inst:' || substr(encode(extensions.digest(p_installation_id, 'sha256'), 'hex'), 1, 32), 300, 3);\n    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));\n`);
  }, ["03_claims.test.mjs"]],
  ["claim_start: stored hash is plaintext-derivable (code stored as hex of the code)", (s) => s.replace("values (p_installation_id, v_uid, v_sid, extensions.digest(v_code, 'sha256'), 'pending', v_expires)", "values (p_installation_id, v_uid, v_sid, extensions.digest(v_code, 'md5'), 'pending', v_expires)"), ["03_claims.test.mjs"]],
];

async function cloneDb() {
  const sup = await connectSuper("postgres");
  try {
    await sup.query(`drop database if exists ${CLONE} with (force)`);
    for (let i = 0; i < 10; i += 1) {
      await sup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [DB]);
      try {
        await sup.query(`create database ${CLONE} template ${DB}`);
        return;
      } catch (e) {
        if (!/being accessed/.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error("clone failed");
  } finally {
    await sup.end();
  }
}

const only = process.argv[2];
let survived = 0;
const report = [];
for (const [name, mutate, files] of mutants) {
  if (only && !name.includes(only)) continue;
  const sql = mutate(original);
  if (sql === original) throw new Error(`mutation did not change the migration: ${name}`);
  await cloneDb();
  const tmp = path.join(os.tmpdir(), `mut-${Date.now()}.sql`);
  fs.writeFileSync(tmp, sql);
  const apply = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", "fdb_migrator", "-d", CLONE, "-f", tmp], { env: { ...process.env, PGPASSWORD: "local-test-password" }, encoding: "utf8" });
  fs.unlinkSync(tmp);
  if (apply.status !== 0) {
    report.push(`KILLED (migration refuses to apply): ${name}`);
    continue;
  }
  const run = spawnSync("node", ["--test", "--test-concurrency=1", ...files.map((f) => path.join(here, f))], { env: { ...process.env, FDB_IT_DB: CLONE }, encoding: "utf8", timeout: 300_000 });
  const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]).filter((n) => !/^(\/|[a-z_]+ \()/.test(n));
  if (run.status === 0) {
    survived += 1;
    report.push(`SURVIVED: ${name}`);
  } else {
    report.push(`KILLED by ${failed.length} test(s), e.g. "${(failed[0] ?? "suite").slice(0, 90)}": ${name}`);
  }
}
const sup = await connectSuper("postgres");
await sup.query(`drop database if exists ${CLONE} with (force)`);
await sup.end();
console.log(report.join("\n"));
console.log(`\n${report.length - survived}/${report.length} mutants killed, ${survived} survived`);
process.exit(survived === 0 ? 0 : 1);
