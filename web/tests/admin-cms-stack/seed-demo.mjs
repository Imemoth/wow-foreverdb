// Creates the DEMO staff accounts of the disposable Admin CMS stack for MANUAL testing by the Product Owner.
//   cd web && node tests/admin-cms-stack/seed-demo.mjs
// Every account is a real GoTrue user with a real, already-enrolled TOTP factor. All demo accounts share the fixed, PUBLIC test password below (the
// stack is a throw-away cluster that never leaves this machine). Nothing secret is printed: the TOTP code of an account is read on demand with
//   node tests/admin-cms-stack/totp.mjs <email>
// Re-running creates fresh accounts.
const DEMO_PASSPHRASE = "demo-staff-passphrase-public-test-value";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(resolve(here, ".stack/env"), "utf8").split("\n").map((l) => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const gw = env.ACCOUNT_STACK_URL, anon = env.ACCOUNT_STACK_ANON_KEY;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function totp(secret) {
  const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, acc = 0; const bytes = [];
  for (const ch of secret.toUpperCase().replace(/=+$/, "")) { acc = (acc << 5) | a.indexOf(ch); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(c).digest();
  return String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0");
}
async function post(path, body, token) {
  const r = await fetch(`${gw}/auth/v1${path}`, { method: "POST", headers: { apikey: anon, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const db = new pg.Client({ host: env.E2E_PG_HOST, port: Number(env.E2E_PG_PORT), user: env.E2E_PG_USER, password: env.E2E_PG_PASSWORD, database: env.E2E_DB });
await db.connect();
const tag = randomBytes(2).toString("hex");
const people = [
  { name: "Editor", roles: ["Editor"] },
  { name: "Second Editor (reviewer)", roles: ["Editor"] },
  { name: "Administrator (approver)", roles: ["Administrator"] },
  { name: "Owner (publisher)", roles: ["Owner"] },
];
const out = [];
for (const p of people) {
  const email = `${p.name.split(" ")[0].toLowerCase()}-${p.name.includes("Second") ? "2-" : ""}${tag}@example.test`;
  const s = await post("/signup", { email, password: DEMO_PASSPHRASE });
  const uid = s.body.user.id;
  await db.query("insert into admin_private.staff_subjects(user_id,status) values($1,'active')", [uid]);
  for (const role of p.roles) {
    await db.query(`insert into admin_private.role_assignments(user_id,role_name,policy_version_id,environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,approved_by,reason)
      values($1,$2,1,'staging','global',clock_timestamp()-interval '1 minute',case when $2='Owner' then null else clock_timestamp()+interval '29 days' end,clock_timestamp()+interval '30 days','active',$1,'demo fixture')`, [uid, role]);
  }
  const enrol = await post("/factors", { factor_type: "totp", friendly_name: "AzerDex Admin", issuer: "AzerDex" }, s.body.access_token);
  const ch = await post(`/factors/${enrol.body.id}/challenge`, {}, s.body.access_token);
  const v = await post(`/factors/${enrol.body.id}/verify`, { challenge_id: ch.body.id, code: totp(enrol.body.totp.secret) }, s.body.access_token);
  if (v.status !== 200) throw new Error(`TOTP verify failed for ${email}: ${v.status}`);
  out.push({ role: p.name, email });

}
await db.end();
console.log("\nDemo staff accounts (disposable stack only). The shared test password is DEMO_PASSPHRASE in tests/admin-cms-stack/seed-demo.mjs and in the docs.\n");
for (const o of out) console.log(`${o.role}\n  email:     ${o.email}\n  TOTP code: node tests/admin-cms-stack/totp.mjs ${o.email}\n`);
console.log("Sign in at http://localhost:3220/account/login, press \"Request TOTP challenge\" and enter the code to reach /admin.");
