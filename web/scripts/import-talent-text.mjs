#!/usr/bin/env node
// Builds the talent description overlay (text.json) and the exact coverage report for one game build.
//
//   node scripts/import-talent-text.mjs \
//     --dataset src/data/talents/forever/1.60.1.70630 \
//     --templates <dir of <class>.json: normalized trait data with descriptionTemplate per entry> --templates-build 1.60.1.70532 \
//     --templates-ref <repo@commit> \
//     --spell-values <spell-values.json of the TARGET build> --spell-values-ref <repo@commit:path> \
//     [--spell-values-prev <spell-values.json of the templates' build>] [--check]
//
// What is accepted as a description (nothing else is ever written):
//   1. the raw client template must reproduce the target build's own text hash (sha256(description \0 aura)[0:12], recorded in
//      spell-values.json). A template that does not is NOT shown: it may belong to another build.
//   2. when the templates come from another build than the target, the spell's effect rows and duration must be identical in
//      both builds (--spell-values-prev), otherwise the per-rank structure of the template cannot be trusted for the target.
//   3. values are filled in only from the TARGET build's spell data. Per-rank (curve) values are used only when the templates
//      come from the target build itself; otherwise they stay explicit gaps. Gaps are never guessed or filled from other builds.
// The result is validated as a whole; on any failure nothing is written and the previous files stay in place (exit 1).
// Output: text.json (azerdex.talent-text/2), coverage.json, COVERAGE.md next to the dataset. See docs/web/class-guides-talents.md.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { buildSync } = createRequire(join(here, "..", "package.json"))("esbuild");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const need = (name) => {
  const v = arg(name);
  if (!v) {
    console.error(`missing --${name}; see the header of scripts/import-talent-text.mjs`);
    process.exit(2);
  }
  return v;
};

const datasetDir = resolve(need("dataset"));
const templatesDir = resolve(need("templates"));
const templatesBuild = need("templates-build");
const templatesRef = need("templates-ref");
const svPath = resolve(need("spell-values"));
const svRef = need("spell-values-ref");
const svPrevPath = arg("spell-values-prev") ? resolve(arg("spell-values-prev")) : null;
const checkOnly = flag("check");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const textHash = (description, aura = "") => sha256(description + "\0" + aura).slice(0, 12);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// The resolver is the application's own TypeScript module; bundle it so the importer and the site can never disagree.
const tmp = mkdtempSync(join(tmpdir(), "azerdex-tooltip-"));
const bundle = join(tmp, "tooltip.mjs");
buildSync({ entryPoints: [join(here, "..", "src", "lib", "talents", "tooltip.ts")], bundle: true, format: "esm", outfile: bundle, logLevel: "error" });
const { renderTemplate, tidySegments, GAP_TEXT } = await import(bundle);

const manifest = readJson(join(datasetDir, "manifest.json"));
const build = manifest.build.version;
const sv = readJson(svPath);
if ((sv.build?.version ?? sv.build) !== build) throw new Error(`spell-values is for build ${JSON.stringify(sv.build)}, dataset is ${build}`);
const svPrev = svPrevPath ? readJson(svPrevPath) : null;
const sameBuild = templatesBuild === build;
if (!sameBuild && !svPrev) throw new Error("templates are from another build: --spell-values-prev (spell rows of the templates' build) is required");

// templates by node id
const nodes = new Map();
const templateFiles = {};
for (const f of readdirSync(templatesDir).filter((n) => n.endsWith(".json") && n !== "manifest.json").sort()) {
  const raw = readFileSync(join(templatesDir, f));
  templateFiles[f.replace(/\.json$/, "")] = sha256(raw);
  for (const t of JSON.parse(raw.toString("utf8")).trees ?? []) for (const n of t.nodes) nodes.set(n.id, n);
}

const classes = Object.keys(manifest.output.sha256);
const rows = [];
const talents = {};

for (const cls of classes) {
  const data = readJson(join(datasetDir, `${cls}.json`));
  for (const tree of data.trees) {
    for (const t of tree.talents) {
      const base = { id: t.id, name: t.name, classId: cls, tree: tree.name, spellId: t.spellId, maxRank: t.maxRank };
      const fail = (status, reason) => rows.push({ ...base, status, gaps: [], ranksVerified: 0, reason });
      const node = nodes.get(t.id);
      const entry = node?.entries?.find((e) => e.spellId === t.spellId);
      if (!node || !entry) { fail("no-template", `The template source has no entry for node ${t.id} / spell ${t.spellId}.`); continue; }
      if (!entry.descriptionTemplate) { fail("no-template", "The template source has an empty description for this entry."); continue; }
      const s = sv.spells[String(t.spellId)];
      if (!s) { fail("no-spell-data", `spell-values for build ${build} has no row for spell ${t.spellId}.`); continue; }
      if (textHash(entry.descriptionTemplate) !== s.textHash) {
        const was = svPrev?.spells[String(t.spellId)]?.textHash;
        fail(
          "unverified",
          was && textHash(entry.descriptionTemplate) === was
            ? `The text changed after build ${templatesBuild}: the template no longer matches build ${build}'s text hash (${s.textHash}). Its description for ${build} needs a client extraction.`
            : `The template does not reproduce build ${build}'s text hash (${s.textHash}); it may include aura text or differ from the client's.`,
        );
        continue;
      }
      if (!sameBuild) {
        const p = svPrev.spells[String(t.spellId)];
        if (!p || JSON.stringify(p.effects) !== JSON.stringify(s.effects) || p.durationMs !== s.durationMs) {
          fail("unverified", `The spell's effect rows or duration differ between ${templatesBuild} and ${build}, so the per-rank structure of the template is unverified.`);
          continue;
        }
      }
      const effects = (s.effects ?? []).map((x) => {
        const fe = (entry.effects ?? []).find((y) => y.index === x.index);
        // Structure (is this value rank-driven?) comes from the templates; the rank VALUES only when they are of the target build.
        const curve = !!fe && fe.perRankStatus !== "none";
        return { index: x.index, basePoints: x.basePoints, dieSides: x.dieSides, periodMs: x.periodMs, chainTargets: x.chainTargets, radiusYards: x.radiusYards, curve, rankValues: curve && sameBuild && fe.perRankStatus === "resolved" ? fe.perRank.map((r) => r.value) : undefined };
      });
      const complete = (rank) => renderTemplate(entry.descriptionTemplate, { effects, durationMs: s.durationMs }, rank);
      const perRank = Array.from({ length: t.maxRank }, (_, i) => complete(i + 1));
      const ranksVerified = perRank.filter((r) => r.complete).length;
      const distinct = new Set(perRank.map((r) => JSON.stringify(tidySegments(r.segments))));
      const gapCodes = [...new Set(perRank.flatMap((r) => r.gaps.map((g) => g.code)))].sort();
      const entryOut = { spellId: t.spellId, templateHash: s.textHash };
      if (distinct.size === 1) {
        entryOut.segments = tidySegments(perRank[0].segments);
        entryOut.complete = perRank[0].complete;
      } else {
        entryOut.ranks = perRank.map((r) => ({ segments: tidySegments(r.segments), complete: r.complete }));
        entryOut.complete = ranksVerified === t.maxRank;
      }
      talents[String(t.id)] = entryOut;
      rows.push({
        ...base,
        status: ranksVerified === t.maxRank ? "complete" : "partial",
        gaps: gapCodes,
        ranksVerified,
        reason: ranksVerified === t.maxRank ? null : gapCodes.map((c) => GAP_TEXT[c]).join(" "),
      });
    }
  }
}

// Whole-result validation. Nothing is written unless all of it holds.
const problems = [];
const ids = new Set(rows.map((r) => r.id));
if (ids.size !== rows.length) problems.push("duplicate talent ids");
for (const [id, e] of Object.entries(talents)) {
  const r = rows.find((x) => String(x.id) === id);
  if (!r || r.spellId !== e.spellId) problems.push(`talent ${id}: spell id mismatch`);
  if (!/^[0-9a-f]{12}$/.test(e.templateHash)) problems.push(`talent ${id}: bad template hash`);
  const lists = e.ranks ? e.ranks.map((x) => x.segments) : [e.segments];
  if (e.ranks && e.ranks.length !== r.maxRank) problems.push(`talent ${id}: ${e.ranks.length} rank texts for ${r.maxRank} ranks`);
  for (const segs of lists) {
    if (!Array.isArray(segs) || segs.length === 0) problems.push(`talent ${id}: empty text`);
    for (const g of segs ?? []) if (typeof g !== "string" && !(g && typeof g.g === "string" && Object.hasOwn(GAP_TEXT, g.c))) problems.push(`talent ${id}: malformed segment`);
    if ((segs ?? []).some((g) => typeof g === "string" && /\$[a-zA-Z0-9{<@?/*]|\|c[0-9a-f]{8}/i.test(g))) problems.push(`talent ${id}: unresolved template syntax leaked into text`);
  }
}
if (rows.length !== 466 && !flag("allow-any-count")) problems.push(`expected 466 talents, got ${rows.length}`);
if (problems.length) {
  console.error("validation failed; nothing written:\n" + [...new Set(problems)].slice(0, 30).join("\n"));
  process.exit(1);
}

// Deterministic output: the timestamp is when the TARGET build's client data was extracted, not when this script ran.
const extractedAt = sv.build?.extractedAt ?? "unknown";
const templatesManifest = existsSync(join(templatesDir, "manifest.json")) ? readJson(join(templatesDir, "manifest.json")) : null;
const source = {
  name: "Client description templates verified against the build's own text hashes",
  reference: `templates: ${templatesRef} (build ${templatesBuild}); spell values + text hashes: ${svRef} (build ${build})`,
  extractedAt,
  templates: { build: templatesBuild, ref: templatesRef, generatedAt: templatesManifest?.generatedAt ?? null, sha256: templateFiles },
  spellValues: { build, ref: svRef, sha256: sha256(readFileSync(svPath)) },
  verification: "raw template hash == target build text hash; effect rows equal across builds; values from the target build only",
};
const textFile = { schema: "azerdex.talent-text/2", build, source, talents };

const by = (pred) => rows.filter(pred).length;
const total = rows.length;
const pct = (n) => `${((100 * n) / total).toFixed(1)}%`;
const summary = {
  classes: classes.length,
  trees: new Set(rows.map((r) => `${r.classId}/${r.tree}`)).size,
  nodes: total,
  withVerifiedText: by((r) => r.status === "complete" || r.status === "partial"),
  everyRankFullyResolved: by((r) => r.status === "complete"),
  partialText: by((r) => r.status === "partial"),
  unverifiedOrMissing: by((r) => r.status !== "complete" && r.status !== "partial"),
  ranksTotal: rows.reduce((n, r) => n + r.maxRank, 0),
  ranksFullyResolved: rows.reduce((n, r) => n + r.ranksVerified, 0),
  withValidIcon: 0,
};
const gapTotals = {};
for (const r of rows) for (const g of r.gaps) gapTotals[g] = (gapTotals[g] ?? 0) + 1;
const coverage = { schema: "azerdex.talent-coverage/1", build, extractedAt, source: { templates: source.templates, spellValues: source.spellValues }, summary, gapTotals, talents: rows };

const iconsPath = join(datasetDir, "icons.json");
const icons = existsSync(iconsPath) ? readJson(iconsPath) : { build: null, icons: {} };
summary.withValidIcon = icons.build === build ? rows.filter((r) => Object.hasOwn(icons.icons, String(r.spellId))).length : 0;

const prevPath = join(datasetDir, "text.json");
const prev = existsSync(prevPath) ? readJson(prevPath) : null;
const diff = { added: [], removed: [], changed: [] };
if (prev && prev.build === build) {
  for (const id of Object.keys(talents)) {
    if (!prev.talents[id]) diff.added.push(id);
    else if (JSON.stringify(prev.talents[id]) !== JSON.stringify(talents[id])) diff.changed.push(id);
  }
  for (const id of Object.keys(prev.talents)) if (!talents[id]) diff.removed.push(id);
} else if (prev?.build) {
  diff.note = `previous text was for build ${prev.build}; not compared`;
}

const md = [];
md.push(`# Talent description coverage - build ${build}`, "");
md.push(`Generated by \`web/scripts/import-talent-text.mjs\` from build ${build} data extracted ${extractedAt}. Do not edit by hand.`, "");
md.push(`Templates: ${templatesRef} (build ${templatesBuild}). Spell values and text hashes: ${svRef} (build ${build}).`, "");
md.push("| Metric | Count | Share |", "| --- | ---: | ---: |");
md.push(`| Classes | ${summary.classes} | |`, `| Talent trees | ${summary.trees} | |`, `| Talent nodes | ${total} | 100% |`);
md.push(`| Nodes with a verified description (complete or partial) | ${summary.withVerifiedText} | ${pct(summary.withVerifiedText)} |`);
md.push(`| Nodes where every rank is fully resolved | ${summary.everyRankFullyResolved} | ${pct(summary.everyRankFullyResolved)} |`);
md.push(`| Nodes with a verified description that still has unresolved numbers | ${summary.partialText} | ${pct(summary.partialText)} |`);
md.push(`| Nodes without a verified description | ${summary.unverifiedOrMissing} | ${pct(summary.unverifiedOrMissing)} |`);
md.push(`| Ranks (all nodes) | ${summary.ranksTotal} | |`, `| Ranks fully resolved | ${summary.ranksFullyResolved} | ${((100 * summary.ranksFullyResolved) / summary.ranksTotal).toFixed(1)}% |`);
md.push(`| Nodes with a valid icon | ${summary.withValidIcon} | ${pct(summary.withValidIcon)} |`, "");
md.push("Unresolved numbers by reason (nodes affected): " + (Object.entries(gapTotals).map(([c, n]) => `${c} ${n}`).join(", ") || "none"), "");
md.push("Reason codes: " + Object.entries(GAP_TEXT).map(([c, t]) => `**${c}** - ${t}`).join(" "), "");
const group = (title, status) => {
  const list = rows.filter((r) => (Array.isArray(status) ? status.includes(r.status) : r.status === status));
  md.push(`## ${title} (${list.length})`, "", "| Node id | Talent | Class / tree | Spell id | Ranks | Reason |", "| ---: | --- | --- | ---: | ---: | --- |");
  for (const r of list) md.push(`| ${r.id} | ${r.name} | ${r.classId} / ${r.tree} | ${r.spellId} | ${r.ranksVerified}/${r.maxRank} | ${(r.gaps.length ? `[${r.gaps.join(", ")}] ` : "") + (r.reason ?? "")} |`);
  md.push("");
};
group("No verified description", ["unverified", "no-template", "no-spell-data"]);
group("Verified description, some numbers unresolved", "partial");
group("Fully resolved", "complete");
md.push("## Icons", "", `Valid icons: ${summary.withValidIcon}/${total}. ${summary.withValidIcon === 0 ? "No icon file data id for this build is available in any accessible source: Everloot's published catalog omits them and the client files cannot be read from this environment. See docs/web/class-guides-talents.md for the extraction steps." : ""}`, "");

console.log(JSON.stringify({ build, summary, gapTotals, diff: { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, note: diff.note } }, null, 2));
if (checkOnly) {
  console.log("--check: validation passed, nothing written");
  process.exit(0);
}
writeFileSync(join(datasetDir, "text.json"), JSON.stringify(textFile, null, 1) + "\n");
writeFileSync(join(datasetDir, "coverage.json"), JSON.stringify(coverage, null, 1) + "\n");
writeFileSync(join(datasetDir, "COVERAGE.md"), md.join("\n") + "\n");
console.log("written: text.json, coverage.json, COVERAGE.md");
