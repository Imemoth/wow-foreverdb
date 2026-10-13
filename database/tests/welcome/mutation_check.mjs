// Mutation check for migration 0015: every deliberately weakened copy must be caught by the suite (manual / not part of the PR gate).
// Usage (stack up): node database/tests/welcome/mutation_check.mjs        Expected survivors are documented defence-in-depth duplicates.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const migration = path.join(repo, "database/migrations/0015_azerdex_welcome_outbox.sql");
const original = readFileSync(migration, "utf8");
const tmp = mkdtempSync(path.join(tmpdir(), "mut-"));
const apply = (file) =>
  spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", process.env.PGHOST ?? "127.0.0.1", "-U", "fdb_migrator", "-d", process.env.FDB_IT_DB ?? "fdb_account_it", "-f", file], {
    env: { ...process.env, PGPASSWORD: "local-test-password" }, encoding: "utf8" });

// [name, find, replace, tests that must fail, expected survivor?]
const T = {
  prov: "20_gotrue_provenance.test.mjs", rpc: "30_worker_rpc.test.mjs", priv: "10_privileges.test.mjs",
};
const M = [
  ["provenance: ignore recovery_sent_at (J becomes eligible)", "              and new.recovery_sent_at is null\n", "", T.prov],
  ["provenance: ignore both recovery_sent_at and the one-time-token check (recovery link becomes eligible)",
    "              and new.recovery_sent_at is null\n              and exists (select 1 from auth.one_time_tokens t where t.user_id = new.id and t.token_type = 'confirmation_token');", ";", T.prov],
  ["provenance: ignore that the confirmation token was just cleared", "              and coalesce(new.confirmation_token, '') = ''\n", "", T.prov, "survivor: GoTrue clears it on confirm; the one-time-token and recovery_sent_at checks already separate the paths"],
  ["signup trigger: ignore enqueue switch", "if v_cfg.enqueue_enabled\n           and v_cfg.activation_at is not null", "if true\n           and v_cfg.activation_at is not null", T.prov],
  ["signup trigger: ignore activation_at", "           and new.created_at >= v_cfg.activation_at\n", "", T.prov],
  ["confirm trigger: ignore enqueue switch", "        if v_cfg.enqueue_enabled then\n            insert into private.azerdex_welcome_outbox (user_id, email_sha256)\n            values (new.id", "        if true then\n            insert into private.azerdex_welcome_outbox (user_id, email_sha256)\n            values (new.id", T.prov],
  ["confirm trigger: not guarded by an exception handler", "        perform private.azerdex_welcome_note_failure(new.id, 'confirm', v_prov);", "        raise;", T.prov],
  ["reconciler: no 7-day bound", "and c.verified_via_signup_at > now() - interval '7 days'", "", T.prov],
  ["claim: ignore dispatch kill switch", "if not v_cfg.dispatch_enabled then", "if false then", T.rpc],
  ["claim: drop SKIP LOCKED", "           for update skip locked", "           for update", T.rpc, "survivor-maybe: under READ COMMITTED the row re-check after the lock wait skips leased rows, so only blocking differs"],
  ["claim: no e-mail change check", "when sha256(convert_to(lower(u.email), 'UTF8')) <> r.email_sha256 then 'email_changed'", "when false then 'email_changed'", T.rpc],
  ["claim: no unverified check", "when u.email_confirmed_at is null or u.email is null then 'ineligible_unverified'", "when false then 'ineligible_unverified'", T.rpc],
  ["claim: no deleted check", "when u.deleted_at is not null then 'ineligible_deleted'", "when false then 'ineligible_deleted'", T.rpc],
  ["claim: no idempotency-window stop", "if r.unknown_outcome and r.first_send_at is not null and now() > r.first_send_at + interval '20 hours' then", "if false then", T.rpc],
  ["claim: no attempt cap", "if r.attempts >= 6 then\n            update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = 'attempts_exhausted',\n                   lease_until = null, lease_token = null, unknown_outcome = r.unknown_outcome, updated_at = now() where user_id = r.user_id;\n            continue;\n        end if;", "", T.rpc, "survivor-maybe: finish() enforces the same cap, so the claim-time check is defence in depth"],
  ["finish: accept any lease token", "if not found or r.status <> 'leased' or r.lease_token is distinct from p_lease_token then", "if not found or r.status <> 'leased' then", T.rpc],
  ["finish: keep the recipient hash after sending", "lease_token = null, unknown_outcome = false, email_sha256 = '\\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,\n               updated_at = now()\n         where user_id = p_user_id;\n        return true;", "lease_token = null, unknown_outcome = false,\n               updated_at = now()\n         where user_id = p_user_id;\n        return true;", T.rpc],
  ["finish: ambiguous retried past the window", "elsif p_outcome = 'ambiguous' and not v_window then", "elsif false then", T.rpc],
  ["acl: authenticated may execute claim", "grant execute on function public.azerdex_welcome_claim(integer) to service_role;", "grant execute on function public.azerdex_welcome_claim(integer) to service_role, authenticated;", T.priv, "assertion"],
  ["role guard removed", "        if v_role is distinct from 'service_role' then", "        if false then", T.priv],
];

let bad = 0;
for (const [name, find, rep, test, flag] of M) {
  if (!original.includes(find)) { console.log(`ERROR (pattern not found): ${name}`); bad++; continue; }
  const f = path.join(tmp, "m.sql");
  writeFileSync(f, original.replace(find, rep));
  const a = apply(f);
  let verdict;
  if (a.status !== 0) verdict = /assertion/.test(a.stderr) ? "KILLED (migration's own post-condition assertion)" : `KILLED (migration refused: ${a.stderr.split("\n")[0].slice(0, 80)})`;
  else {
    const r = spawnSync("node", ["--test", "--test-concurrency=1", path.join(here, test)], { env: { ...process.env, FDB_REQUIRE_GOTRUE: "1" }, encoding: "utf8" });
    verdict = r.status !== 0 ? "KILLED" : "SURVIVED";
  }
  const expected = flag?.startsWith("survivor");
  const good = verdict.startsWith("KILLED") || expected;
  if (!good) bad++;
  console.log(`${verdict.startsWith("KILLED") ? "KILLED  " : expected ? "SURVIVED (expected: " + flag + ")" : "SURVIVED!!"}  ${name}${verdict.startsWith("KILLED") ? "" : ""}`);
}
const r = apply(migration);
console.log(r.status === 0 ? "original restored" : `RESTORE FAILED ${r.stderr}`);
console.log(bad === 0 ? "MUTATION CHECK OK" : `MUTATION CHECK: ${bad} unexpected survivor(s)`);
process.exit(bad === 0 ? 0 : 1);
