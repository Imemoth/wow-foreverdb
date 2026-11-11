#!/usr/bin/env node
// Consistency check for database/MIGRATIONS.md. Pure text and file-name checks: it reads no database and never applies anything.
//   node scripts/check-migration-registry.mjs        -> exit 0 and "migration-registry: PASS", or exit 1 and one line per violation.
//
// What it enforces (see database/MIGRATIONS.md, sections 3 to 7):
//   * every registry ID is well formed (<namespace>/<4 digits><optional letter>) and appears in exactly one row;
//   * every legacy ledger alias, and every ledger version, is unique within its namespace;
//   * every numbered migration file in the scanned directories is claimed by exactly one row (none unregistered, none claimed twice);
//   * a file's own number equals its ID's number, except for the listed historical differences (which keep their file names);
//   * a ledger alias that carries a number (public_read_NNNN_, ops_NNNN_) equals its ID's number, except for the listed historical differences;
//   * a row never claims files from the other namespace's directories;
//   * rows whose status requires a file (applied, no-ledger, restore-only, pending) point at files that exist.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_FILE = "database/MIGRATIONS.md";

// Directories scanned for numbered migration files, and which namespace may own them. database/ops holds operator scripts of BOTH projects, so its files
// are assigned by the registry row that claims them.
export const SCANNED_DIRECTORIES = {
  "database/migrations": "acct",
  "database/private-export": "acct",
  "database/rollback": "acct",
  "database/restore": "acct",
  "database/public-read/migrations": "pubread",
  "database/public-read/ops": "pubread",
  "database/ops": null,
};

// Historical differences that are recorded, not repaired (applied migrations are never renamed or reapplied). Adding to either list is a registry decision.
export const KNOWN_FILE_NUMBER_DIFFERENCES = new Map([
  ["database/public-read/migrations/0002_news_model.sql", "pubread/0007"],   // shares 0002 with 0002_zone_map_points; its ledger alias is public_read_0007_news_model
]);
export const KNOWN_ALIAS_NUMBER_DIFFERENCES = new Map([
  ["public_read_0010_news_vault_scheduler", "pubread/0017"],   // file database/ops/0017_schedule_news_collector_vault.sql; 0010 is held by news_bluepost_suppression
]);

const ID_PATTERN = /^(acct|pubread)\/(\d{4})([a-z]?)$/;
const STATUS_PATTERN = /^(applied|no-ledger|restore-only|reserved|main-only|pending|ledger-only)\b/;
const FILE_OPTIONAL_STATUSES = new Set(["reserved", "main-only", "ledger-only"]);   // the file may legitimately be absent on this branch

const globToRegExp = (pattern) => new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");

export function parseRegistry(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || !/^`(?:acct|pubread)\//.test(cells[1] ?? "")) continue;
    const id = cells[1].replace(/`/g, "");
    rows.push({
      id,
      files: [...cells[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      aliases: [...cells[3].matchAll(/`([a-z0-9_]+)`\s*\((\d{14})\)/g)].map((m) => ({ name: m[1], version: m[2] })),
      ledgerCell: cells[3],
      status: cells[4],
      line,
    });
  }
  return rows;
}

export function checkRegistry({ text, files, exists = (f) => files.includes(f) }) {
  const violations = [];
  const rows = parseRegistry(text);
  if (rows.length === 0) return ["no registry rows found"];

  const seenIds = new Map();
  for (const row of rows) {
    const m = ID_PATTERN.exec(row.id);
    if (!m) { violations.push(`${row.id}: malformed ID (expected <acct|pubread>/<4 digits><optional lowercase letter>)`); continue; }
    if (seenIds.has(row.id)) violations.push(`${row.id}: duplicate registry ID`);
    seenIds.set(row.id, row);
    row.ns = m[1]; row.num = m[2] + m[3];
    const status = STATUS_PATTERN.exec(row.status)?.[1];
    if (!status) { violations.push(`${row.id}: status must start with one of applied, no-ledger, restore-only, reserved, main-only, pending, ledger-only`); continue; }
    row.statusKeyword = status;
    if ((status === "applied" || status === "ledger-only") && row.aliases.length === 0) violations.push(`${row.id}: status ${status} needs at least one ledger alias with its version`);
    if (!/^none\b/i.test(row.ledgerCell) && row.aliases.length === 0) violations.push(`${row.id}: ledger cell must be "none" or list \`alias\` (14-digit version)`);
    if (row.files.length === 0 && status !== "ledger-only" && status !== "reserved") violations.push(`${row.id}: no files listed`);
  }

  // Ledger aliases and versions: unique per namespace; aliases that carry a number must agree with the ID.
  const aliasOwner = new Map(), versionOwner = new Map();
  for (const row of rows.filter((r) => r.ns)) {
    for (const { name, version } of row.aliases) {
      const aliasKey = `${row.ns}:${name}`, versionKey = `${row.ns}:${version}`;
      if (aliasOwner.has(aliasKey)) violations.push(`${row.id}: ledger alias ${name} is also claimed by ${aliasOwner.get(aliasKey)}`);
      aliasOwner.set(aliasKey, row.id);
      if (versionOwner.has(versionKey)) violations.push(`${row.id}: ledger version ${version} is also claimed by ${versionOwner.get(versionKey)}`);
      versionOwner.set(versionKey, row.id);
      const numbered = /^(?:public_read|ops)_(\d{4})_/.exec(name);
      if (numbered && numbered[1] !== row.num.slice(0, 4) && KNOWN_ALIAS_NUMBER_DIFFERENCES.get(name) !== row.id) {
        violations.push(`${row.id}: ledger alias ${name} carries number ${numbered[1]}; list it in KNOWN_ALIAS_NUMBER_DIFFERENCES only as a deliberate historical difference`);
      }
    }
  }

  // Files: each numbered file claimed by exactly one row; numbers agree; namespaces respected; claimed files exist where required.
  const numberedFiles = files.filter((f) => /^\d{4}/.test(path.posix.basename(f)) && Object.keys(SCANNED_DIRECTORIES).some((d) => path.posix.dirname(f) === d));
  const claims = new Map(numberedFiles.map((f) => [f, []]));
  for (const row of rows.filter((r) => r.ns && r.statusKeyword)) {
    for (const entry of row.files) {
      const matches = files.filter((f) => globToRegExp(entry).test(f));
      if (matches.length === 0 && !FILE_OPTIONAL_STATUSES.has(row.statusKeyword) && !exists(entry)) violations.push(`${row.id}: file ${entry} does not exist (status ${row.statusKeyword})`);
      for (const file of matches) {
        if (claims.has(file)) claims.get(file).push(row.id);
        const dirNs = SCANNED_DIRECTORIES[path.posix.dirname(file)];
        if (dirNs && dirNs !== row.ns) violations.push(`${row.id}: claims ${file}, which lives in a ${dirNs} directory`);
        const fileNumber = /^(\d{4}[a-z]?)(?=_|\.)/.exec(path.posix.basename(file))?.[1];
        if (fileNumber && fileNumber !== row.num && KNOWN_FILE_NUMBER_DIFFERENCES.get(file) !== row.id) {
          violations.push(`${row.id}: file ${file} has number ${fileNumber}; list it in KNOWN_FILE_NUMBER_DIFFERENCES only as a deliberate historical difference`);
        }
      }
    }
  }
  for (const [file, owners] of claims) {
    if (owners.length === 0) violations.push(`${file}: numbered migration file is not registered in ${REGISTRY_FILE}`);
    else if (new Set(owners).size > 1) violations.push(`${file}: claimed by more than one ID (${[...new Set(owners)].join(", ")})`);
  }
  for (const [file, id] of KNOWN_FILE_NUMBER_DIFFERENCES) if (files.includes(file) && !seenIds.has(id)) violations.push(`${file}: known difference points at ${id}, which is not in the registry`);
  return violations;
}

export function collectFiles(root = ROOT) {
  const out = [];
  for (const dir of Object.keys(SCANNED_DIRECTORIES)) {
    const abs = path.join(root, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".sql")) out.push(`${dir}/${entry.name}`);
  }
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = checkRegistry({ text: readFileSync(path.join(ROOT, REGISTRY_FILE), "utf8"), files: collectFiles(), exists: (f) => existsSync(path.join(ROOT, f)) });
  if (violations.length) {
    console.error("migration-registry: FAIL");
    for (const v of violations) console.error(`- ${v}`);
    process.exitCode = 1;
  } else {
    console.log("migration-registry: PASS");
  }
}
