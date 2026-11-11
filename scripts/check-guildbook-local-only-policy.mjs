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

// 0018 is the only migration allowed to define the ingest wrapper and the Guildbook-stripping projection. A later migration may CALL them, but only in
// the exact forms below, and only in the one reviewed file (reviewed 2026-11-11 against the 0018 boundary): pre-flight existence tests written as a boolean
// `to_regprocedure('...') is null` (never as an object handle that could be cast to text or passed to EXECUTE or format), and the single call
// that passes every upload through the projection. These forms are removed before scanning, so ANY other mention of either object (a definition, alter,
// drop, rename, grant, revoke, quoted identifier, dynamic SQL, or a call that bypasses the projection) is still reported by the rule below.
// No content hash is used: a hash would go stale on every harmless edit and would let any matching copy through under a new name.
const REVIEWED_PROJECTION_USE = new Map([
  ["0019_technical_installation_ingest.sql", [
    /\bto_regprocedure\s*\(\s*'private\.(?:foreverdb_ingest_snapshot_impl_v1|fdb_public_snapshot)\(jsonb\)'\s*\)\s+is\s+null\b/gi,
    /\bprivate\.foreverdb_ingest_snapshot_impl_v1\s*\(\s*private\.fdb_public_snapshot\s*\(\s*p_snapshot\s*\)\s*\)/gi,
  ]],
]);

const sha256 = (text) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
// Removes SQL comments while respecting string literals, quoted identifiers and dollar-quoted bodies, so that text such as  select '--'; drop function ...;
// cannot hide a statement behind a comment marker. String and identifier text is kept (it is still scanned); comments, including nested block comments, are
// replaced by a space. A dollar-quoted body is scanned recursively because function bodies are SQL too. This only ever exposes MORE text than before.
// A hand-written lexer can always be wrong somewhere, so it is never the only defence: the statement-shaped rules ALSO run on the raw text (see below), and
// anything the lexer cannot close (an unterminated string, identifier, comment or dollar quote) is reported instead of being scanned on a guess.
const IDENT = /[\p{L}\p{N}_$]/u;
const lex = (sql, state = { unterminated: false }) => {
  let out = "", lastStringEnd = -1, lastStringEscapes = false;
  for (let i = 0; i < sql.length;) {
    const c = sql[i], d = sql[i + 1];
    if (c === "-" && d === "-") { while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") i++; out += " "; continue; }   // PostgreSQL ends a -- comment at \n OR a lone \r
    if (c === "/" && d === "*") {
      let depth = 1; i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; } else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; } else i++;
      }
      if (depth > 0) state.unterminated = true;
      out += " "; continue;
    }
    if (c === "'") {
      // E'...' has backslash escapes; the E must not be the tail of an identifier or a qualified name (public.e'..' is a typed literal). A string that continues
      // after whitespace containing a newline inherits the escape mode of the previous literal (PostgreSQL concatenates them).
      const before = sql[i - 1] ?? "";
      const prefixE = /[eE]/.test(before) && !IDENT.test(sql[i - 2] ?? "") && (sql[i - 2] ?? "") !== ".";
      const between = lastStringEnd >= 0 ? sql.slice(lastStringEnd, i) : null;
      const continuation = between !== null && /^\s*$/.test(between) && /[\r\n]/.test(between);
      const escapes = prefixE || (continuation && lastStringEscapes);
      let j = i + 1, closed = false;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) state.unterminated = true;
      out += sql.slice(i, j + 1); i = j + 1; lastStringEnd = i; lastStringEscapes = escapes; continue;
    }
    if (c === '"') {
      let j = i + 1, closed = false;
      while (j < sql.length) { if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } closed = true; break; } j++; }
      if (!closed) state.unterminated = true;
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === "$" && !IDENT.test(sql[i - 1] ?? "")) {   // a $ that continues an identifier (a$$) or a number is not a dollar-quote opener
      const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) { state.unterminated = true; }
        else { out += tag[0] + lex(sql.slice(i + tag[0].length, end), state).text + tag[0]; i = end + tag[0].length; continue; }
      }
    }
    out += c; i++;
  }
  return { text: out, unterminated: state.unterminated };
};
const uncomment = (sql) => lex(sql).text;
export { lex };   // exported for the regression tests only

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

    const reviewedForms = REVIEWED_PROJECTION_USE.get(path.basename(file.name)) ?? [];
    const withoutReviewed = (text) => reviewedForms.reduce((acc, reviewed) => acc.replace(reviewed, " "), text);
    const lexed = lex(file.sql);
    if (lexed.unterminated) violations.push(`${file.name}: unterminated string, identifier, comment or dollar quote (cannot be scanned safely)`);
    const sql = withoutReviewed(lexed.text);
    const rawSql = withoutReviewed(file.sql);   // comments NOT removed: no lexer state can hide a statement from the shape rules below
    const mention = [/\b(?:foreverdb_ingest_snapshot_impl_v1|fdb_public_snapshot)\w*/i, "ingest wrapper/projection modification"];
    const shapes = [
      [/\bprivate\s*\.\s*account_guildbook_[a-z0-9_]*/i, "account-scoped cloud Guildbook storage"],
      [/\b(?:create|alter)\s+table\b[^;]*(?:guildbook|installation_guilds|installation_guild_members|installation_guild_professions)/i, "Guildbook cloud table definition or alteration"],
      [/\bcreate\s+(?:or\s+replace\s+)?function\s+(?:public|private)\s*\.\s*\w*guildbook\w*/i, "new Guildbook RPC/function"],
      [/\bgrant\s+execute\s+on\s+function\b[^;]*\w*guildbook\w*/i, "Guildbook RPC execution grant"],
      [/\b(?:insert\s+into|copy\s+into)\b[^;]*\bselect\b[^;]*(?:installation_guild|account_guildbook|guildbook)/i, "copy of historical Guildbook records"],
      [/\b(?:insert\s+into|update|delete\s+from)\b[^;]*(?:installation_guild|account_guildbook|guildbook)/i, "Guildbook cloud data write"],
      [/\b(?:revoke|grant)\s+execute\b[^;]*\w*guildbook\w*/i, "Guildbook RPC privilege change"],
      [/\b(?:create(?:\s+or\s+replace)?|alter|drop)\s+function\b[^;(]*(?:foreverdb_ingest_snapshot_impl_v1|fdb_public_snapshot)/i, "ingest wrapper/projection modification"],
      [/\b(?:grant|revoke)\b[^;]*(?:foreverdb_ingest_snapshot_impl_v1|fdb_public_snapshot)/i, "ingest wrapper/projection modification"],
    ];
    const found = new Set();
    for (const [pattern, reason] of [...shapes, mention, [/\b(?:guildbook_upload|upload_guildbook|sync_guildbook|guildbook_sync|backup_guildbook)\w*/i, "Guildbook upload, sync, or backup path"]]) {
      if (pattern.test(sql)) found.add(reason);
    }
    for (const [pattern, reason] of shapes) if (pattern.test(rawSql)) found.add(reason);   // second pass on the raw text (defence in depth)
    for (const reason of found) violations.push(`${file.name}: ${reason}`);
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
