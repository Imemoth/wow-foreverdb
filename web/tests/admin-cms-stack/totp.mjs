// Prints the current 6-digit TOTP code of a demo staff account of the DISPOSABLE stack: the stand-in for an authenticator app.
//   node tests/admin-cms-stack/totp.mjs <email>            (reads the account's TOTP secret from the throw-away database)
//   node tests/admin-cms-stack/totp.mjs --secret <BASE32>  (any base32 secret)
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const arg = process.argv[2];
if (!arg) { console.error("usage: node tests/admin-cms-stack/totp.mjs <email> | --secret <base32>"); process.exit(64); }
let secret = arg === "--secret" ? process.argv[3] : null;
if (!secret) {
  const here = dirname(fileURLToPath(import.meta.url));
  const env = Object.fromEntries(readFileSync(resolve(here, ".stack/env"), "utf8").split("\n").map((l) => l.match(/^([A-Z_0-9]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const db = new pg.Client({ host: env.E2E_PG_HOST, port: Number(env.E2E_PG_PORT), user: env.E2E_PG_USER, password: env.E2E_PG_PASSWORD, database: env.E2E_DB });
  await db.connect();
  const r = await db.query("select f.secret from auth.mfa_factors f join auth.users u on u.id=f.user_id where lower(u.email)=lower($1) and f.status='verified' and f.factor_type='totp' limit 1", [arg]);
  await db.end();
  secret = r.rows[0]?.secret;
  if (!secret) { console.error("no verified TOTP factor for that email in the disposable stack"); process.exit(1); }
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = 0, acc = 0; const bytes = [];
for (const ch of secret.toUpperCase().replace(/=+$/, "")) { const n = alphabet.indexOf(ch); acc = (acc << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0")}   (valid for about ${left}s)`);
