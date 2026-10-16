// Regression tests for the CID emblem (G-1) and for the deployed-bundle layout (G-7), run on a REAL Deno runtime.
//
// What is proven: the emblem is committed, is a valid 128x128 PNG within the size cap, is EMBEDDED in the import graph (logo-data.ts, generated and
// sha256-checked against the PNG) and the entry point (Deno.serve) works when ONLY the local import graph reported by `deno info` is present and
// the process has NO file-read permission. What is NOT proven here: Supabase's own bundler/deploy (needs a hosted project).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLogo, LOGO_MAX_BYTES } from "../../supabase/functions/azerdex-welcome-worker/logo.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fnDir = path.join(root, "supabase/functions/azerdex-welcome-worker");
const png = path.join(fnDir, "azerdex-logo.png");
const configToml = fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8");
const denoBin = process.env.DENO_BIN || "deno";
const haveDeno = spawnSync(denoBin, ["--version"]).status === 0;
const SECRET = "deno-test-secret-0123456789abcdef0123456789";

test("AS-1 the emblem is committed, a valid 128x128 PNG, within the cap, with an alpha channel", () => {
  const bytes = new Uint8Array(fs.readFileSync(png));
  const logo = validateLogo(bytes);
  assert.ok(logo.bytes > 1000 && logo.bytes <= LOGO_MAX_BYTES, `size ${logo.bytes}`);
  // IHDR colour type 3 (palette, needs tRNS for alpha) or 6 (RGBA): the emblem has a transparent glow and must keep it.
  const colorType = bytes[25];
  assert.ok(colorType === 6 || (colorType === 3 && Buffer.from(bytes).includes(Buffer.from("tRNS"))), `colour type ${colorType}`);
});

test("AS-1b the emblem decodes structurally: every chunk CRC valid, IHDR first, IDAT present, IEND last with no trailing bytes, no text/exif chunks", () => {
  const b = fs.readFileSync(png);
  let off = 8;
  const types = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    assert.equal(b.readUInt32BE(off + 8 + len), crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), `CRC of ${type}`);
    types.push(type);
    off += 12 + len;
  }
  assert.equal(off, b.length, "no trailing bytes after the last chunk");
  assert.equal(types[0], "IHDR");
  assert.equal(types.at(-1), "IEND");
  assert.ok(types.includes("IDAT"));
  assert.deepEqual(types.filter((t) => !["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(t)), [], "only critical chunks (+tRNS): nothing that can carry metadata or a payload");
});

test("AS-2 the emblem is the pinned asset (a changed file must be a conscious, reviewed change)", () => {
  const sha = createHash("sha256").update(fs.readFileSync(png)).digest("hex");
  const recorded = fs.readFileSync(path.join(fnDir, "azerdex-logo.sha256"), "utf8").trim().split(/\s+/)[0];
  assert.equal(sha, recorded);
});

test("AS-3 the emblem is embedded, not read from disk: generated module is current, decodes to the pinned PNG, the code reads no file, and config relies on no static_files", async () => {
  const gen = spawnSync("node", [path.join(root, "scripts/embed-azerdex-logo.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(gen.status, 0, gen.stdout + gen.stderr);
  const { LOGO_PNG_BASE64, LOGO_PNG_SHA256 } = await import("../../supabase/functions/azerdex-welcome-worker/logo-data.ts");
  const bytes = Buffer.from(LOGO_PNG_BASE64, "base64");
  assert.deepEqual(new Uint8Array(bytes), new Uint8Array(fs.readFileSync(png)));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LOGO_PNG_SHA256);
  const index = fs.readFileSync(path.join(fnDir, "index.ts"), "utf8");
  assert.match(index, /from "\.\/logo-data\.ts"/);
  for (const f of fs.readdirSync(fnDir).filter((x) => x.endsWith(".ts"))) { // EVERY worker source, not just the entry point
    assert.ok(!/Deno\.(readFile|readTextFile|open|readDir|stat)|node:fs|import\.meta\.url/.test(fs.readFileSync(path.join(fnDir, f), "utf8")), `${f}: no runtime file access`);
  }
  assert.ok(!/^\s*static_files\s*=/m.test(configToml), "no static_files: API-based deploys cannot ship them");
  assert.match(configToml, /^verify_jwt\s*=\s*false/m);
});

test("AS-4 no externally hosted image is configured anywhere in the worker sources", () => {
  for (const f of fs.readdirSync(fnDir).filter((x) => x.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(fnDir, f), "utf8");
    assert.ok(!/<img[^>]+src="https?:/i.test(src), f);
  }
});

function localGraph() {
  const r = spawnSync(denoBin, ["info", "--json", path.join(fnDir, "index.ts")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).modules.filter((m) => m.kind === "esm" && m.local).map((m) => m.local);
}

/** Copy ONLY what a deployment would contain: the local import graph (no static files exist in this design). */
function stageBundle({ tamper = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azerdex-bundle-"));
  const dest = path.join(dir, "functions/azerdex-welcome-worker");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of localGraph()) {
    assert.ok(f.startsWith(fnDir), `unexpected local module outside the function directory: ${f}`);
    fs.copyFileSync(f, path.join(dest, path.basename(f)));
  }
  if (tamper) { // flip one base64 character of the embedded emblem: a corrupted bundle must fail closed
    const f = path.join(dest, "logo-data.ts");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/(LOGO_PNG_BASE64 =\s*")(.{40})(.)/s, (_m, a, b, c) => `${a}${b}${c === "A" ? "B" : "A"}`));
  }
  return { dir, entry: path.join(dest, "index.ts") };
}

async function runEntry({ entry, dir }, dbCalls) {
  const db = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      dbCalls.push({ url: req.url, apikey: req.headers.apikey, body: b });
      res.setHeader("content-type", "application/json");
      res.end(req.url.endsWith("azerdex_welcome_claim") ? "[]" : "true");
    });
  });
  await new Promise((r) => db.listen(0, "127.0.0.1", r));
  const dbPort = db.address().port;
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const child = spawn(denoBin, ["run", `--allow-net=127.0.0.1:${port},127.0.0.1:${dbPort}`, "--allow-env=AZERDEX_WELCOME_ENABLED,AZERDEX_WELCOME_MODE,AZERDEX_WELCOME_MAX_PER_RUN,AZERDEX_WORKER_SECRET,RESEND_API_KEY,SUPABASE_URL,AZERDEX_WORKER_DB_KEY,SUPABASE_SERVICE_ROLE_KEY", entry], {
    env: {
      PATH: process.env.PATH, HOME: dir, DENO_DIR: path.join(dir, ".deno"),
      DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`,
      AZERDEX_WELCOME_ENABLED: "true", AZERDEX_WORKER_SECRET: SECRET, RESEND_API_KEY: "re_test_not_real_000000",
      SUPABASE_URL: `http://127.0.0.1:${dbPort}`, AZERDEX_WORKER_DB_KEY: "db-key-not-real-0123456789",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const call = async (headers = {}, method = "POST") => {
    for (let i = 0; i < 100; i++) {
      try { return await fetch(`http://127.0.0.1:${port}/`, { method, headers }); } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error(`server did not start: ${log}`);
  };
  return { call, log: () => log, stop: async () => { child.kill(); await new Promise((r) => db.close(r)); } };
}

test("AS-5 [Deno] deployed layout (import graph only, NO file-read permission): Deno.serve authenticates, validates the embedded emblem and reaches the database (no send: queue empty)", { skip: !haveDeno && process.env.FDB_REQUIRE_DENO !== "1" && "BLOCKED: deno not installed" }, async () => {
  assert.ok(haveDeno, "deno is required (FDB_REQUIRE_DENO=1)");
  const b = stageBundle();
  const dbCalls = [];
  const s = await runEntry(b, dbCalls);
  try {
    assert.equal((await s.call({})).status, 401);
    assert.equal((await s.call({ "x-azerdex-worker-secret": "wrong" })).status, 401);
    assert.equal((await s.call({}, "GET")).status, 405);
    assert.equal(dbCalls.length, 0, "unauthorized calls never reach the database");
    const ok = await s.call({ "x-azerdex-worker-secret": SECRET });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { state: "ok", claimed: 0, sent: 0, retry: 0, ambiguous: 0, permanent: 0, finish_failed: 0 });
    assert.deepEqual(dbCalls.map((c) => c.url), ["/rest/v1/rpc/azerdex_welcome_claim"]);
    assert.equal(dbCalls[0].apikey, "db-key-not-real-0123456789");
    assert.ok(!s.log().includes(SECRET), "the secret never appears in logs");
  } finally { await s.stop(); fs.rmSync(b.dir, { recursive: true, force: true }); }
});

test("AS-6 [Deno] a CORRUPTED embedded emblem fails closed: logo_invalid, no claim, nothing sent", { skip: !haveDeno && process.env.FDB_REQUIRE_DENO !== "1" && "BLOCKED: deno not installed" }, async () => {
  assert.ok(haveDeno, "deno is required (FDB_REQUIRE_DENO=1)");
  const b = stageBundle({ tamper: true });
  const dbCalls = [];
  const s = await runEntry(b, dbCalls);
  try {
    const r = await s.call({ "x-azerdex-worker-secret": SECRET });
    assert.equal((await r.json()).state, "logo_invalid");
    assert.equal(dbCalls.length, 0);
  } finally { await s.stop(); fs.rmSync(b.dir, { recursive: true, force: true }); }
});
