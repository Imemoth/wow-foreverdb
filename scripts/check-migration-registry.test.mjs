import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { REGISTRY_FILE, checkRegistry, collectFiles, parseRegistry } from "./check-migration-registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realText = readFileSync(path.join(ROOT, REGISTRY_FILE), "utf8");
const realFiles = collectFiles(ROOT);
const run = (text, files = realFiles) => checkRegistry({ text, files });
const hasViolation = (violations, fragment) => violations.some((v) => v.includes(fragment));
const removeRow = (text, id) => text.split("\n").filter((l) => !l.startsWith(`| \`${id}\``)).join("\n");
const editRow = (text, id, fn) => text.split("\n").map((l) => (l.startsWith(`| \`${id}\``) ? fn(l) : l)).join("\n");

describe("migration registry consistency check", () => {
  it("accepts the real registry against the real migration directories", () => {
    assert.deepEqual(run(realText), []);
    assert(parseRegistry(realText).length > 40, "the registry rows are parsed");
  });

  it("the original ambiguity cannot return: both 0002 files map to different, unique IDs", () => {
    const rows = parseRegistry(realText);
    const owner = (file) => rows.filter((r) => r.files.includes(file)).map((r) => r.id);
    assert.deepEqual(owner("database/public-read/migrations/0002_zone_map_points.sql"), ["pubread/0002"]);
    assert.deepEqual(owner("database/public-read/migrations/0002_news_model.sql"), ["pubread/0007"]);
    const ids = rows.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "every registry ID is unique");
  });

  it("rejects a duplicate registry ID, including the original pubread/0002 ambiguity (negative)", () => {
    const ambiguous = editRow(realText, "pubread/0007", (l) => l.replace("`pubread/0007`", "`pubread/0002`"));
    const violations = run(ambiguous);
    assert(hasViolation(violations, "pubread/0002: duplicate registry ID"), violations.join("\n"));
    assert(hasViolation(violations, "known difference points at pubread/0007, which is not in the registry"), violations.join("\n"));
  });

  it("rejects a malformed ID and an unknown namespace (negative)", () => {
    assert(hasViolation(run(editRow(realText, "acct/0005", (l) => l.replace("`acct/0005`", "`acct/5`"))), "malformed ID"));
    assert(hasViolation(run(editRow(realText, "acct/0005", (l) => l.replace("`acct/0005`", "`acct/0005A`"))), "malformed ID"));
  });

  it("rejects a duplicate ledger alias or version within a namespace (negative)", () => {
    const aliasTwice = editRow(realText, "pubread/0011", (l) => l.replace("`news_collector_v2` (20261104094201)", "`news_bluepost_suppression_v1` (20261104094201)"));
    assert(hasViolation(run(aliasTwice), "ledger alias news_bluepost_suppression_v1 is also claimed"));
    const versionTwice = editRow(realText, "pubread/0011", (l) => l.replace("(20261104094201)", "(20261023090320)"));
    assert(hasViolation(run(versionTwice), "ledger version 20261023090320 is also claimed"));
  });

  it("rejects an unregistered migration file and a file claimed by two IDs (negative)", () => {
    assert(hasViolation(run(removeRow(realText, "pubread/0008")), "0008_news_ingest_role.sql: numbered migration file is not registered"));
    assert(hasViolation(run(realText, [...realFiles, "database/migrations/0021_new_thing.sql"]), "0021_new_thing.sql: numbered migration file is not registered"));
    const twice = editRow(realText, "pubread/0009", (l) => l.replace("`database/public-read/migrations/0009_news_ingest_search_path.sql`", "`database/public-read/migrations/0009_news_ingest_search_path.sql`, `database/public-read/migrations/0008_*.sql`"));
    assert(hasViolation(run(twice), "claimed by more than one ID"));
  });

  it("rejects an unexplained difference between a file number or ledger alias number and its ID (negative)", () => {
    const wrongId = editRow(realText, "pubread/0003", (l) => l.replace("`pubread/0003`", "`pubread/0099`"));
    assert(hasViolation(run(wrongId), "has number 0003"));
    const aliasNumber = editRow(realText, "pubread/0008", (l) => l.replace("`public_read_0008_news_ingest_role`", "`public_read_0042_news_ingest_role`"));
    assert(hasViolation(run(aliasNumber), "carries number 0042"));
  });

  it("the two historical differences are the only ones the check tolerates (they are recorded, not repaired)", () => {
    const newsModelUnderOtherId = editRow(realText, "pubread/0007", (l) => l.replace("`pubread/0007`", "`pubread/0042`"));
    assert(hasViolation(run(newsModelUnderOtherId), "0002_news_model.sql has number 0002"), "0002_news_model.sql is tolerated only under pubread/0007");
    const vaultUnderOwnNumber = editRow(realText, "pubread/0017", (l) => l.replace("`public_read_0010_news_vault_scheduler` (20261022104843)", "`public_read_0010_news_vault_scheduler` (20261022104843), `public_read_0099_x` (20261022104844)"));
    assert(hasViolation(run(vaultUnderOwnNumber), "carries number 0099"));
  });

  it("rejects a row that claims files from the other namespace (negative)", () => {
    const crossing = editRow(realText, "pubread/0013", (l) => l.replace("`database/public-read/migrations/0013_news_global_story_grouping.sql`", "`database/migrations/0018_disable_guildbook_cloud_sync.sql`"));
    assert(hasViolation(run(crossing), "lives in a acct directory"));
  });

  it("requires files for applied rows but waives them for reserved, main-only and ledger-only rows (positive and negative)", () => {
    assert.deepEqual(run(realText, realFiles.filter((f) => !f.endsWith("0019_technical_installation_ingest.sql") && !f.endsWith("0020_admin_private_authorization.sql"))), []);
    const missingApplied = realFiles.filter((f) => !f.endsWith("0005_guildbook_v1.sql"));
    assert(hasViolation(run(realText, missingApplied), "acct/0005: file database/migrations/0005_guildbook_v1.sql does not exist"));
  });

  it("rejects a bad status keyword and an applied row without a ledger alias (negative)", () => {
    assert(hasViolation(run(editRow(realText, "acct/0007", (l) => l.replace("| applied |", "| aplied |"))), "status must start with one of"));
    assert(hasViolation(run(editRow(realText, "acct/0007", (l) => l.replace("`restrict_legacy_public_stats` (20261008153743)", "none"))), "needs at least one ledger alias"));
  });
});
