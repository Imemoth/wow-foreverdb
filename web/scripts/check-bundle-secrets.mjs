#!/usr/bin/env node
/**
 * Fails if anything secret-looking reaches the browser bundle (.next/static)
 * or if browser source maps were emitted. Run after `next build`.
 * Also checks the actual VALUES of server-only secrets present in the build env.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), ".next", "static");
const FORBIDDEN = [
  /klxhikdlfwgxurdyexdi/, // private production project ref
  /service_role/i,
  /postgres(ql)?:\/\//i,
  /PUBLIC_READ_DATABASE_URL/,
  /UPSTASH_REDIS_REST_TOKEN/,
  /RATE_LIMIT_SALT/,
  /CHALLENGE_COOKIE_SECRET/,
  /TURNSTILE_SECRET_KEY/,
  /sb_secret_/,
  /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{20,}/, // JWT-looking literal
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SECRET_ENV = ["PUBLIC_READ_DATABASE_URL", "UPSTASH_REDIS_REST_TOKEN", "RATE_LIMIT_SALT", "CHALLENGE_COOKIE_SECRET", "TURNSTILE_SECRET_KEY"];
const values = SECRET_ENV.map((k) => process.env[k]).filter((v) => v && v.length >= 8);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let failures = 0, files = 0;
for (const file of walk(ROOT)) {
  files++;
  if (file.endsWith(".map")) { console.error(`FAIL source map shipped: ${file}`); failures++; continue; }
  if (!/\.(js|css|html|json|txt)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const re of FORBIDDEN) if (re.test(text)) { console.error(`FAIL ${re} in ${file}`); failures++; }
  for (const v of values) if (text.includes(v)) { console.error(`FAIL secret env value found in ${file}`); failures++; }
}
if (files === 0) { console.error("FAIL no build output found; run next build first"); process.exit(1); }
console.log(failures ? `bundle secret scan: ${failures} finding(s) in ${files} files` : `bundle secret scan: PASS (${files} files)`);
process.exit(failures ? 1 : 0);
