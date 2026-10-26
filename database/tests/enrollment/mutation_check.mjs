// Mutation check for migration 0014: proves the suite CAN fail. Each mutant weakens ONE security property in a copy of the migration,
// applies it over a throw-away clone of the integration database (0012 and 0014 already applied; the body is idempotent) and runs the
// relevant test files against the clone. Every mutant must be KILLED. Not part of the PR gate (slow); run before review:
//   PGUSER=... PGPASSWORD=... node database/tests/enrollment/mutation_check.mjs [name-filter]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DB, HOST, PORT, connectSuper, repoRoot } from "../account/harness.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const original = fs.readFileSync(path.join(repoRoot, "database/migrations/0014_zero_touch_enrollment.sql"), "utf8");
const CLONE = `${DB}_mut14`;

const sub = (from, to) => (s) => {
  if (!s.includes(from)) throw new Error(`mutation target not found: ${from.slice(0, 80)}`);
  return s.replace(from, to);
};
const T = "02_tickets.test.mjs";
const F = "03_flows.test.mjs";
const C = "04_concurrency.test.mjs";
const K = "05_credentials.test.mjs";
const P = "01_privileges.test.mjs";
const R = "06_failure_recovery.test.mjs";

const mutants = [
  ["ticket TTL is 24 hours instead of 168", sub("v_expires := clock_timestamp() + interval '168 hours';", "v_expires := clock_timestamp() + interval '24 hours';"), [T]],
  ["ticket stored as plaintext-derivable md5 instead of sha256", sub("values (v_uid, extensions.digest(v_ticket, 'sha256'), v_label, 'pending'", "values (v_uid, extensions.digest(v_ticket, 'md5'), v_label, 'pending'"), [T]],
  ["pending-ticket cap raised to 500", sub("and t.expires_at > clock_timestamp()) >= 5", "and t.expires_at > clock_timestamp()) >= 500"), [T]],
  ["hourly issuance cap removed", sub("where t.account_uid = v_uid and t.created_at > clock_timestamp() - interval '1 hour') >= 10", "where t.account_uid = v_uid and t.created_at > clock_timestamp() - interval '1 hour') >= 100000"), [T]],
  ["issue: anonymous callers accepted", sub("v_uid := private.fdb_registered_caller();\n    perform private.foreverdb_take_budget('ticket_issue:uid:'", "v_uid := private.fdb_caller();\n    perform private.foreverdb_take_budget('ticket_issue:uid:'"), [P]],
  ["tickets list: not scoped to the caller", sub("    from private.enrollment_tickets t\n    where t.account_uid = v_uid\n    order by t.created_at desc", "    from private.enrollment_tickets t\n    order by t.created_at desc"), [T]],
  ["ticket revoke: any account may revoke any ticket", sub("where t.id = p_ticket_id and t.account_uid = v_uid\n    for update;", "where t.id = p_ticket_id\n    for update;"), [T]],
  ["enroll: consumed tickets accepted (replay)", sub("if v_status = 'consumed' or v_status = 'revoked' or v_expires <= clock_timestamp() then", "if v_status = 'revoked' or v_expires <= clock_timestamp() then"), [T]],
  ["enroll: expiry ignored", sub("if v_status = 'consumed' or v_status = 'revoked' or v_expires <= clock_timestamp() then", "if v_status = 'consumed' or v_status = 'revoked' then"), [T]],
  ["enroll: revoked tickets accepted", sub("if v_status = 'consumed' or v_status = 'revoked' or v_expires <= clock_timestamp() then", "if v_status = 'consumed' or v_expires <= clock_timestamp() then"), [T]],
  ["enroll: account standing not checked", sub("    if not private.fdb_account_usable(v_account) then\n        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)\n        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_unavailable');", "    if false then\n        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)\n        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_unavailable');"), [T]],
  ["enroll: registered callers accepted", sub("    v_d := private.fdb_anonymous_caller();\n    v_sid := (auth.jwt() ->> 'session_id')::uuid;\n\n    perform private.foreverdb_take_budget('enroll:uid:'", "    v_d := private.fdb_caller();\n    v_sid := (auth.jwt() ->> 'session_id')::uuid;\n\n    perform private.foreverdb_take_budget('enroll:uid:'"), [P]],
  ["enroll: installation owned by someone else is taken over (no conflict)", sub("if v_owner is distinct from v_account then\n            -- Another account", "if false then\n            -- Another account"), [F]],
  ["enroll: second active device allowed for an installation (cloned SavedVariables)", sub("            if v_dev.auth_uid <> v_d then\n                insert into private.device_audit", "            if false then\n                insert into private.device_audit"), [F]],
  ["enroll: one identity may be the device of several installations", sub("if found and (v_dev.installation_id <> p_installation_id or v_dev.account_uid <> v_account) then", "if false then"), [F]],
  ["enroll: device cap removed", sub("    if v_live >= 10 then", "    if v_live >= 100000 then"), [F]],
  ["enroll: installation reserved for the DEVICE identity, not the account", sub("values (p_installation_id, v_account, 0, 'enrolled', now(), now());", "values (p_installation_id, v_d, 0, 'enrolled', now(), now());"), [F]],
  ["enroll: ticket row not locked (concurrent redemption)", sub("from private.enrollment_tickets t where t.id = v_ticket_id for update;", "from private.enrollment_tickets t where t.id = v_ticket_id;"), [C]],
  ["enroll: per-installation advisory lock removed", sub("    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));\n    perform private.foreverdb_take_budget('enroll:global', 300, 120);\n    perform private.fdb_lock_live_session(v_d, v_sid, true);", "    perform private.foreverdb_take_budget('enroll:global', 300, 120);\n    perform private.fdb_lock_live_session(v_d, v_sid, true);"), [C]],
  ["authorize: revoked devices still authorized", sub("    if o_device.status <> 'active' then\n        o_reason := 'revoked';\n        return;\n    end if;\n", ""), [K]],
  ["authorize: ownership drift not detected", sub("    if v_owner is distinct from o_device.account_uid then\n        o_reason := 'ownership_conflict';\n        return;\n    end if;\n", ""), [F]],
  ["authorize: account standing not checked", sub("    if not private.fdb_account_usable(o_device.account_uid) then\n        o_reason := 'account_unavailable';\n        return;\n    end if;\n", ""), [K]],
  ["authorize: device principal (Auth uid) not compared", sub("if not found or o_device.auth_uid is distinct from p_uid then", "if not found then"), [F]],
  ["authorize: reuse of a retired credential never revokes", sub("        if o_device.status <> 'revoked' then\n            -- A superseded credential used after the grace window", "        if false then\n            -- A superseded credential used after the grace window"), [K]],
  ["authorize: grace window for retired credentials removed", sub("o_device.retired_at > clock_timestamp() - interval '120 seconds'", "false"), [K]],
  ["authorize: next credential never promoted", sub("    if v_match = 'next' then\n        update private.devices", "    if false then\n        update private.devices"), [K]],
  ["ingest: payload installation not compared to the device's installation", sub("    if v_dev_installation <> v_installation then", "    if false then"), [F]],
  ["ingest: identity swap leaks (claims not restored)", sub("    perform set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);\n    perform set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);\n", ""), [F]],
  ["ingest: ingest quota gate removed", sub("    perform private.foreverdb_api_gate('ingest');\n\n    if jsonb_typeof(p_snapshot)", "    if jsonb_typeof(p_snapshot)"), [K]],
  ["ingest: payload bounds removed", sub("        or octet_length(p_snapshot::text) > 8388608\n        or (p_snapshot ? 'sources' and jsonb_typeof(p_snapshot->'sources') <> 'array')\n        or (p_snapshot ? 'guilds' and jsonb_typeof(p_snapshot->'guilds') <> 'array')\n        or jsonb_array_length(coalesce(p_snapshot->'sources', '[]'::jsonb)) > 2500\n        or jsonb_array_length(coalesce(p_snapshot->'guilds', '[]'::jsonb)) > 100\n", ""), [K]],
  ["ingest: not serialised with revoke (advisory lock removed)", sub("    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));\n    perform private.fdb_lock_live_session(v_d, v_sid, true);\n\n    select * into v_auth from private.fdb_device_authorize(p_device_secret, v_d);\n    v_dev := v_auth.o_device;\n    v_reason := v_auth.o_reason;\n    if v_reason is not null then\n        if v_reason not in ('unknown', 'stale_credential') then\n            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)\n            values ('ingest_refused'", "    perform private.fdb_lock_live_session(v_d, v_sid, true);\n\n    select * into v_auth from private.fdb_device_authorize(p_device_secret, v_d);\n    v_dev := v_auth.o_device;\n    v_reason := v_auth.o_reason;\n    if v_reason is not null then\n        if v_reason not in ('unknown', 'stale_credential') then\n            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)\n            values ('ingest_refused'"), [C]],
  // Equivalent mutants, deliberately not listed (defence in depth, each layer alone is unobservable):
  //  * authorize: the device principal comparison -- every caller (status, ingest, rotate) already selects the installation with
  //    `d.auth_uid = v_d` before authorize runs, so another identity never reaches it;
  //  * device revoke: the account scope exists in BOTH lookups; removing only one still yields `not_available`. The combined mutant is listed.
  ["device revoke: no account scoping in either lookup", (s) => sub("select d.status into v_status from private.devices d where d.id = p_device_id and d.account_uid = v_uid for update;", "select d.status into v_status from private.devices d where d.id = p_device_id for update;")(sub("select d.installation_id into v_installation from private.devices d where d.id = p_device_id and d.account_uid = v_uid;", "select d.installation_id into v_installation from private.devices d where d.id = p_device_id;")(s)), [F]],
  ["devices list: not scoped to the caller", sub("    from private.devices d\n    where d.account_uid = v_uid\n    order by (d.status = 'revoked')", "    from private.devices d\n    order by (d.status = 'revoked')"), [F]],
  ["device functions: no SECURITY DEFINER search_path pin on rotate", sub("create or replace function public.fdb_device_rotate_credential(p_device_secret text)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = ''", "create or replace function public.fdb_device_rotate_credential(p_device_secret text)\nreturns jsonb\nlanguage plpgsql\nsecurity definer\nset search_path = public"), [P]],
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
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-mutation14-"));
  let apply;
  try {
    const file = path.join(privateDir, "mutated.sql");
    fs.writeFileSync(file, sql, { flag: "wx", mode: 0o600 });
    apply = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", "fdb_migrator", "-d", CLONE, "-f", file], { env: { ...process.env, PGPASSWORD: "local-test-password" }, encoding: "utf8" });
  } finally {
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
  if (apply.status !== 0) {
    report.push(`KILLED (migration refuses to apply): ${name}`);
    continue;
  }
  const run = spawnSync("node", ["--test", "--test-concurrency=1", ...files.map((f) => path.join(here, f))], { env: { ...process.env, FDB_IT_DB: CLONE }, encoding: "utf8", timeout: 300_000 });
  const failed = [...run.stdout.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
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
