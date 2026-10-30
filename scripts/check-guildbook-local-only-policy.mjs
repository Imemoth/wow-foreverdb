#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_DIRS = ["database/migrations", "supabase/migrations"];
const APPROVED_0018_SHA256 = "976aea6957c06710f9f0cfb1027eb66284b7a614f1cea979952727966e2250ee";

// Historical cloud definitions are allowed only byte-for-byte. A rename, edit, or copy into a new migration
// loses this exception and is scanned as new SQL behavior.
const HISTORICAL_SHA256 = new Map([
  ["0005_guildbook_v1.sql", "3073e1ff6b34d2084a9f5461341deca4ba7add3eeb71688da7a7d2d6a354befe"],
  ["0009_api_security_rate_limits.sql", "e0187986f68d3de01a561bed56968f35962ab4f4999e3a9253ec50dfbe549b96"],
  ["0012_account_ownership_claims.sql", "ca1aaf34b9d6eaadaafcc42ebb5f19d4ae1c3303fb23d6978e7a05e48cb5a31b"],
  ["0014_zero_touch_enrollment.sql", "daf6767a60eef7f450b7af136ac4f10e00cf05bbd452264561d8ee9d9857d3d1"],
]);

const sha256 = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const uncomment = (sql) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");

export function guildbookPolicyViolations(files) {
  const violations = [];
  const has0018 = files.some((f) => f.name === "0018_disable_guildbook_cloud_sync.sql");
  if (!has0018) violations.push("approved 0018 protection migration is missing");

  for (const file of files) {
    const hash = sha256(file.sql);
    if (/^0016(?:_|\.|$)/i.test(path.basename(file.name))) {
      violations.push(`${file.name}: migration number 0016 is permanently reserved`);
    }
    if (file.name === "0018_disable_guildbook_cloud_sync.sql") {
      if (hash !== APPROVED_0018_SHA256) violations.push(`${file.name}: approved 0018 protection changed`);
      continue;
    }
    if (HISTORICAL_SHA256.get(path.basename(file.name)) === hash) continue;

    const sql = uncomment(file.sql);
    const rules = [
      [/\bprivate\s*\.\s*account_guildbook_[a-z0-9_]*/i, "account-scoped cloud Guildbook storage"],
      [/\b(?:create|alter)\s+table\b[^;]*(?:guildbook|installation_guilds|installation_guild_members|installation_guild_professions)/i, "Guildbook cloud table definition or alteration"],
      [/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public|private)\s*\.\s*\w*guildbook\w*/i, "new Guildbook RPC/function"],
      [/\bgrant\s+execute\s+on\s+function\b[^;]*\w*guildbook\w*/i, "Guildbook RPC execution grant"],
      [/\b(?:guildbook_upload|upload_guildbook|sync_guildbook|guildbook_sync|backup_guildbook)\w*/i, "Guildbook upload, sync, or backup path"],
      [/\b(?:insert\s+into|copy\s+into)\b[^;]*\bselect\b[^;]*(?:installation_guild|account_guildbook|guildbook)/i, "copy of historical Guildbook records"],
      [/\b(?:insert\s+into|update|delete\s+from)\b[^;]*(?:installation_guild|account_guildbook|guildbook)/i, "Guildbook cloud data write"],
      [/\b(?:revoke|grant)\s+execute\b[^;]*\w*guildbook\w*/i, "Guildbook RPC privilege change"],
      [/\b(?:foreverdb_ingest_snapshot_impl_v1|fdb_public_snapshot)\b/i, "ingest wrapper/projection modification"],
    ];
    for (const [pattern, reason] of rules) if (pattern.test(sql)) violations.push(`${file.name}: ${reason}`);
  }
  return violations;
}

export function loadMigrationFiles(root = ROOT) {
  return MIGRATION_DIRS.flatMap((dir) => {
    const abs = path.join(root, dir);
    try {
      return readdirSync(abs, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
        .map((entry) => ({ name: entry.name, sql: readFileSync(path.join(abs, entry.name), "utf8") }));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const scanRoot = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1] ?? "") : ROOT;
  const violations = guildbookPolicyViolations(loadMigrationFiles(scanRoot));
  if (violations.length) {
    console.error("guildbook-local-only-policy: FAIL");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("guildbook-local-only-policy: PASS");
  }
}
