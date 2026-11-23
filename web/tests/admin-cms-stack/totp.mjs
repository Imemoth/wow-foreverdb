// Prints the current 6-digit TOTP code for a base32 secret (the stand-in for an authenticator app in the disposable environment).
//   node tests/admin-cms-stack/totp.mjs <SECRET>
import { createHmac } from "node:crypto";
const secret = process.argv[2];
if (!secret) { console.error("usage: node tests/admin-cms-stack/totp.mjs <base32 secret>"); process.exit(64); }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = 0, acc = 0; const bytes = [];
for (const ch of secret.toUpperCase().replace(/=+$/, "")) { const n = alphabet.indexOf(ch); acc = (acc << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); } }
const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${String((h.readUInt32BE(h[h.length - 1] & 15) & 0x7fffffff) % 1000000).padStart(6, "0")}   (valid for about ${left}s)`);
