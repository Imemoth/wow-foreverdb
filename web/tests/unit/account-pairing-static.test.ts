import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "web/src");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const p = join(dir, name); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(SRC).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
const code = (f: string) => readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("pairing static trust boundary", () => {
  it("keeps native RPC names in the closed registry and RPC client", () => {
    expect(files.filter((f) => /fdb_device_pair_/.test(code(f))).map((f) => relative(SRC, f)).sort()).toEqual(["lib/account/contracts-pairing.ts", "lib/account/rpc-client.ts"]);
    for (const f of files.filter((f) => relative(SRC, f).startsWith("app/account/"))) expect(code(f), f).not.toMatch(/callNativePairingRpc|fdb_device_pair_/);
    expect(files.filter((f) => /\/rest\/v1\/rpc\//.test(code(f))).map((f) => relative(SRC, f))).toEqual(["lib/account/rpc-client.ts"]);
  });

  it("does not expose pairing transport, caller tokens or polling proof to client bundles or logs", () => {
    expect(code(join(SRC, "lib/account/rpc-client.ts"))).toMatch(/import "server-only"/);
    for (const f of files) {
      const text = code(f);
      if (/^[\s]*["']use client["']/m.test(text)) {
        const imports = ts.preProcessFile(readFileSync(f, "utf8"), true, true).importedFiles.map((x) => x.fileName);
        expect(imports.filter((x) => /rpc-client|contracts-pairing|pairing-gate/.test(x)), f).toEqual([]);
        expect(text, f).not.toMatch(/pollSecret|poll_secret|deviceCredentialHash|device_credential_hash|accessToken|fdbp1_/);
      }
      if (/lib\/account\//.test(relative(SRC, f))) for (const call of text.matchAll(/(?:console\.\w+|accountLog)\(([^;]*)\);/g)) expect(call[1], f).not.toMatch(/pollSecret|poll_secret|accessToken|deviceCredential|pairingId|p_pairing_id/);
    }
    for (const name of ["contracts-pairing.ts", "pairing-gate.ts"]) expect(code(join(SRC, "lib/account", name))).not.toMatch(/process\.env|\bfetch\(|console\.|service_role|sb_secret_/);
  });

  it("release scanner refuses changed source approval and changed database defaults", () => {
    const temp = mkdtempSync(join(tmpdir(), "fdb-pairing-flags-"));
    try {
      for (const name of ["scripts/check-pilot-flags.py", "companion/ForeverDB.Companion.Account/AccountFeatureGate.cs", "web/src/lib/account/config.ts", "web/src/lib/account/pairing-gate.ts"]) {
        mkdirSync(dirname(join(temp, name)), { recursive: true }); cpSync(join(ROOT, name), join(temp, name));
      }
      const migration = join(temp, "database/migrations/0016_browser_pairing.sql");
      mkdirSync(dirname(migration), { recursive: true });
      const off = "create table private.device_pairing_config (singleton boolean primary key default true, enabled boolean not null default false);\ninsert into private.device_pairing_config (singleton, enabled) values (true, false);\n";
      writeFileSync(migration, off);
      const scan = () => spawnSync("python3", [join(temp, "scripts/check-pilot-flags.py"), "--require-off"], { encoding: "utf8" });
      expect(scan().status).toBe(0);
      rmSync(migration);
      expect(scan().status).toBe(1);
      writeFileSync(migration, off);
      const gate = join(temp, "web/src/lib/account/pairing-gate.ts");
      const original = readFileSync(gate, "utf8");
      writeFileSync(gate, original.replace("BROWSER_PAIRING_WEB_APPROVED = false", "BROWSER_PAIRING_WEB_APPROVED = true"));
      expect(scan().status).toBe(1);
      writeFileSync(gate, original);
      writeFileSync(migration, off.replace("enabled boolean not null default false", "enabled boolean not null default true"));
      expect(scan().status).toBe(1);
      writeFileSync(migration, off.replace("values (true, false)", "values (true, true)"));
      expect(scan().status).toBe(1);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
