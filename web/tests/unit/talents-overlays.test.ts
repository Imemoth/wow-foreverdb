import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLASS_MOTIF, TREE_MOTIF, treeMotif } from "@/components/classes/backdrops";
import { TalentCard } from "@/components/talents/TalentCard";
import { NodeFace, type NodeState } from "@/components/talents/TalentIcon";
import { CLASS_COLORS } from "@/lib/classes/colors";
import rawPriest from "@/data/talents/forever/1.60.1.70634/priest.json";
import { layoutHash } from "@/lib/talents/build-code";
import { createEngine } from "@/lib/talents/engine";
import { resolveTalentIcons, talentIconBase, talentIconImgOrigin } from "@/lib/talents/icons";
import { getTalentData, getTalentIcons, getTextStatus, TALENT_BUILD, TALENT_ICONS, TALENT_TEXT } from "@/lib/talents/registry";
import { TalentClassSchema } from "@/lib/talents/schema";
import { applyTalentText, talentTextPublished, textForRank } from "@/lib/talents/text";
import type { TalentClassData, TalentIconManifest, TalentTextFile } from "@/lib/talents/types";
import { buildPageCsp } from "@/lib/security/headers";

const CLASSES = Object.keys(CLASS_COLORS);
// The structural data without any text overlay: synthetic overlays below are merged into this.
const priest = rawPriest as unknown as TalentClassData;
const flat = priest.trees.flatMap((t) => t.talents);
const byName = (n: string) => flat.find((t) => t.name === n)!;
const BUILD = TALENT_BUILD.version;
const SOURCE = { name: "synthetic test source", reference: "unit test", extractedAt: "2026-01-01" };

const text = (over: Partial<TalentTextFile> & Pick<TalentTextFile, "talents">): TalentTextFile => ({ schema: "azerdex.talent-text/1", build: BUILD, source: SOURCE, ...over });

const DIR = join(process.cwd(), "src", "data", "talents", "forever", BUILD);
const coverage = JSON.parse(readFileSync(join(DIR, "coverage.json"), "utf8")) as {
  build: string;
  summary: Record<string, number>;
  talents: Array<{ id: number; spellId: number; maxRank: number; status: string; gaps: string[]; ranksVerified: number; reason: string | null; name: string }>;
};

describe("shipped overlays", () => {
  it("text.json is the v2 overlay of the dataset build, with its provenance", () => {
    expect(TALENT_TEXT.schema).toBe("azerdex.talent-text/2");
    expect(TALENT_TEXT.build).toBe(BUILD);
    expect(TALENT_TEXT.source?.reference).toMatch(/Everloot\/everloot@[0-9a-f]{40}/);
    expect(TALENT_TEXT.source?.verification).toMatch(/text hash/);
  });

  it("every entry belongs to a real talent of its build (same node id and spell id) and has a text hash", () => {
    const all = new Map(CLASSES.flatMap((c) => getTalentData(c, { FOREVERDB_DEPLOYMENT: "local" })!.trees.flatMap((t) => t.talents)).map((t) => [String(t.id), t]));
    for (const [id, e] of Object.entries(TALENT_TEXT.talents)) {
      const t = all.get(id);
      expect(t, id).toBeTruthy();
      expect(e.spellId, id).toBe(t!.spellId);
      expect(e.templateHash, id).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("the coverage report accounts for every one of the 466 talents and matches what is shipped", () => {
    expect(coverage.build).toBe(BUILD);
    expect(coverage.talents).toHaveLength(466);
    expect(new Set(coverage.talents.map((t) => t.id)).size).toBe(466);
    const shipped = Object.keys(TALENT_TEXT.talents).length;
    const withText = coverage.talents.filter((t) => t.status === "complete" || t.status === "partial");
    expect(withText).toHaveLength(shipped);
    expect(coverage.summary.withVerifiedText).toBe(shipped);
    expect(coverage.summary.everyRankFullyResolved).toBe(coverage.talents.filter((t) => t.status === "complete").length);
    expect(coverage.summary.ranksFullyResolved).toBe(coverage.talents.reduce((n, t) => n + t.ranksVerified, 0));
    for (const t of coverage.talents) {
      if (t.status === "complete") expect(t.ranksVerified, t.name).toBe(t.maxRank);
      else expect(t.reason, `${t.name} must say exactly why it is not complete`).toBeTruthy();
      if (t.status === "partial") expect(t.gaps.length, t.name).toBeGreaterThan(0);
      expect(Object.hasOwn(TALENT_TEXT.talents, String(t.id)), t.name).toBe(t.status === "complete" || t.status === "partial");
    }
  });

  it("a talent counted as fully resolved really has no gap in its shipped text", () => {
    for (const t of coverage.talents.filter((x) => x.status === "complete")) {
      const e = TALENT_TEXT.talents[String(t.id)]!;
      const lists = e.ranks ? e.ranks.map((r) => r.segments) : [e.segments!];
      for (const segs of lists) expect(segs.every((g) => typeof g === "string"), t.name).toBe(true);
    }
  });

  it("merging text never changes the layout hash, so shared build links stay valid", () => {
    for (const c of CLASSES) {
      const raw = JSON.parse(readFileSync(join(DIR, `${c}.json`), "utf8")) as TalentClassData;
      const merged = getTalentData(c, { FOREVERDB_DEPLOYMENT: "local" })!;
      expect(layoutHash(merged), c).toBe(layoutHash(raw));
      expect(TalentClassSchema.parse(merged)).toBeTruthy();
    }
  });

  it("merged text reaches the class data exactly where the coverage report says", () => {
    let merged = 0;
    for (const c of CLASSES) {
      for (const t of getTalentData(c, { FOREVERDB_DEPLOYMENT: "local" })!.trees.flatMap((x) => x.talents)) {
        if (t.rankText) merged++;
        expect(Boolean(t.rankText), t.name).toBe(Object.hasOwn(TALENT_TEXT.talents, String(t.id)));
      }
      expect(getTextStatus(c, { FOREVERDB_DEPLOYMENT: "local" })).toMatchObject({ state: "applied", build: BUILD });
    }
    expect(merged).toBe(coverage.summary.withVerifiedText);
  });

  it("is withheld on a production deployment unless explicitly switched on", () => {
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "production" })).toBe(false);
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "production", AZERDEX_TALENT_TEXT: "1" })).toBe(true);
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "preview" })).toBe(true);
    expect(talentTextPublished({ FOREVERDB_DEPLOYMENT: "local" })).toBe(true);
    for (const c of CLASSES) {
      const prod = { FOREVERDB_DEPLOYMENT: "production" };
      expect(getTextStatus(c, prod)).toEqual({ state: "withheld" });
      expect(getTalentData(c, prod)!.trees.every((t) => t.talents.every((x) => x.rankText === undefined))).toBe(true);
      expect(getTextStatus(c, { ...prod, AZERDEX_TALENT_TEXT: "1" }).state).toBe("applied");
    }
  });

  it("ships the icon manifest of the dataset build: every talent's spell is mapped, 358 distinct images, ids only", () => {
    expect(TALENT_ICONS.schema).toBe("azerdex.talent-icons/1");
    expect(TALENT_ICONS.build).toBe(BUILD);
    const talents = CLASSES.flatMap((c) => getTalentData(c, { FOREVERDB_DEPLOYMENT: "local" })!.trees.flatMap((t) => t.talents));
    expect(talents).toHaveLength(466);
    for (const t of talents) {
      const id = TALENT_ICONS.icons[String(t.spellId)];
      expect(id !== undefined && Number.isInteger(id) && id > 0 && id < 2 ** 31, `${t.name} (${t.spellId})`).toBe(true);
    }
    expect(Object.keys(TALENT_ICONS.icons)).toHaveLength(466);
    expect(new Set(Object.values(TALENT_ICONS.icons)).size).toBe(358);
    expect(coverage.summary.withValidIcon).toBe(466);
  });

  it("the icon inventory matches the manifest one-to-one and records hashes only", () => {
    const inv = JSON.parse(readFileSync(join(DIR, "icons-inventory.json"), "utf8")) as { build: string; uniqueImages: number; talents: number; files: Record<string, { webpSha256: string; webpBytes: number; width: number; height: number; sourceBlpSha256: string | null }> };
    expect(inv.build).toBe(BUILD);
    expect(inv.talents).toBe(466);
    expect(Object.keys(inv.files).map(Number).sort((a, b) => a - b)).toEqual([...new Set(Object.values(TALENT_ICONS.icons))].sort((a, b) => a - b));
    expect(inv.uniqueImages).toBe(358);
    for (const [id, f] of Object.entries(inv.files)) {
      expect(f.webpSha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect(f.sourceBlpSha256, id).toMatch(/^[0-9a-f]{64}$/);
      expect([f.width, f.height], id).toEqual([64, 64]);
      expect(f.webpBytes, id).toBeGreaterThan(100);
    }
  });

  it("no Blizzard image is tracked in the repository (talent icons live only on the asset host)", () => {
    let files: string[];
    try {
      files = execFileSync("git", ["ls-files"], { cwd: join(process.cwd(), ".."), encoding: "utf8" }).split("\n");
    } catch {
      return; // not a git checkout (e.g. an exported source tree): nothing to inspect
    }
    const offending = files.filter((f) => /\.blp$/i.test(f) || /talent-icons\/.+\.(webp|png|jpe?g|blp)$/i.test(f));
    expect(offending).toEqual([]);
  });

  it("never mixes in an overlay from another build", () => {
    // The shipped files must be empty or stamped with the dataset build; anything else would be mismatched text presented as verified.
    expect(TALENT_TEXT.build === null || TALENT_TEXT.build === BUILD).toBe(true);
    expect(TALENT_ICONS.build === null || TALENT_ICONS.build === BUILD).toBe(true);
  });
});

describe("applyTalentText (v2: build-verified templates)", () => {
  const pil = byName("Power in Light");
  const hash = "0123456789ab";
  const v2 = (talents: TalentTextFile["talents"], over: Partial<TalentTextFile> = {}): TalentTextFile => ({ schema: "azerdex.talent-text/2", build: BUILD, source: SOURCE, talents, ...over });

  it("merges one text for all ranks, marks gaps, and keeps the data valid", () => {
    const entry = { spellId: pil.spellId, templateHash: hash, segments: ["Deals ", { g: "$m1", c: "curve" as const }, "% more."], complete: false };
    const { data, status } = applyTalentText(priest, v2({ [pil.id]: entry }));
    expect(status).toMatchObject({ state: "applied", covered: 1, complete: 0 });
    const t = data.trees.flatMap((x) => x.talents).find((x) => x.id === pil.id)!;
    expect(t.rankText).toHaveLength(1);
    for (const r of [0, 1, 5]) expect(textForRank(t, r)!.segments).toEqual(entry.segments);
    expect(textForRank(t, 1)!.complete).toBe(false);
    expect(TalentClassSchema.parse(data)).toBeTruthy();
    expect(layoutHash(data)).toBe(layoutHash(priest));
  });

  it("merges per-rank text only with exactly maxRank entries", () => {
    const ranks = Array.from({ length: pil.maxRank }, (_, i) => ({ segments: [`Rank ${i + 1}`], complete: true }));
    const ok = applyTalentText(priest, v2({ [pil.id]: { spellId: pil.spellId, templateHash: hash, ranks, complete: true } }));
    const t = ok.data.trees.flatMap((x) => x.talents).find((x) => x.id === pil.id)!;
    expect(textForRank(t, 3)!.segments).toEqual(["Rank 3"]);
    expect(ok.status).toMatchObject({ covered: 1, complete: 1 });
    const bad = applyTalentText(priest, v2({ [pil.id]: { spellId: pil.spellId, templateHash: hash, ranks: ranks.slice(0, 2) } }));
    expect(bad.status).toEqual({ state: "none" });
  });

  it("refuses entries of another spell, without a hash, with unknown gap codes or empty text", () => {
    const seg = ["x"];
    const cases = [
      { spellId: pil.spellId + 1, templateHash: hash, segments: seg },
      { spellId: pil.spellId, segments: seg },
      { spellId: pil.spellId, templateHash: "not-a-hash", segments: seg },
      { spellId: pil.spellId, templateHash: hash, segments: [{ g: "$m1", c: "made-up" }] },
      { spellId: pil.spellId, templateHash: hash, segments: [] },
    ];
    for (const e of cases) expect(applyTalentText(priest, v2({ [pil.id]: e as never })).status, JSON.stringify(e)).toEqual({ state: "none" });
  });

  it("ignores a v2 overlay of another build and withholds it when not published", () => {
    const entry = { spellId: pil.spellId, templateHash: hash, segments: ["x"] };
    expect(applyTalentText(priest, v2({ [pil.id]: entry }, { build: "1.60.1.70532" })).status).toEqual({ state: "mismatch", textBuild: "1.60.1.70532" });
    const held = applyTalentText(priest, v2({ [pil.id]: entry }), false);
    expect(held.status).toEqual({ state: "withheld" });
    expect(held.data).toBe(priest);
  });
});

describe("applyTalentText", () => {
  const pil = byName("Power in Light");
  const perRank = Array.from({ length: pil.maxRank }, (_, i) => `Rank ${i + 1} text`);

  it("merges per-rank and single descriptions when the build matches, and the result still validates", () => {
    const { data, status } = applyTalentText(priest, text({ talents: { [pil.id]: { descriptions: perRank }, [byName("Shadow Focus").id]: { description: "One text" } } }));
    expect(status).toMatchObject({ state: "applied", build: BUILD, covered: 2, total: flat.length });
    expect(data.trees.flatMap((t) => t.talents).find((t) => t.id === pil.id)!.descriptions).toEqual(perRank);
    expect(data.trees.flatMap((t) => t.talents).find((t) => t.name === "Shadow Focus")!.description).toBe("One text");
    expect(TalentClassSchema.parse(data)).toBeTruthy();
    // Source data is not mutated.
    expect(pil.descriptions).toBeUndefined();
  });

  it("ignores the whole overlay when it was extracted from another build (older or newer)", () => {
    for (const build of ["1.60.1.70532", "1.60.1.70631", "9.9.9.9"]) {
      const r = applyTalentText(priest, text({ build, talents: { [pil.id]: { descriptions: perRank } } }));
      expect(r.status).toEqual({ state: "mismatch", textBuild: build });
      expect(r.data).toBe(priest);
    }
  });

  it("treats a null build, a missing source or an empty overlay as 'none'", () => {
    expect(applyTalentText(priest, text({ build: null, talents: { [pil.id]: { description: "x" } } })).status).toEqual({ state: "none" });
    expect(applyTalentText(priest, text({ source: null, talents: { [pil.id]: { description: "x" } } })).status).toEqual({ state: "none" });
    expect(applyTalentText(priest, text({ talents: {} })).status).toEqual({ state: "none" });
  });

  it("skips entries that do not fit their talent instead of guessing", () => {
    const bad = { [pil.id]: { descriptions: ["only one"] }, [byName("Blackout").id]: { description: "   " }, [byName("Spirit Tap").id]: { description: "x".repeat(2000) } };
    const { data, status } = applyTalentText(priest, text({ talents: bad }));
    expect(status).toEqual({ state: "none" });
    expect(data).toBe(priest);
    // A bad entry next to a good one only drops the bad one.
    const mixed = applyTalentText(priest, text({ talents: { ...bad, [byName("Shadow Focus").id]: { description: "ok" } } }));
    expect(mixed.status).toMatchObject({ state: "applied", covered: 1 });
  });

  it("does not read prototype keys or foreign talent ids", () => {
    const r = applyTalentText(priest, text({ talents: { __proto__: { description: "x" }, constructor: { description: "x" }, "999999999": { description: "x" } } as never }));
    expect(r.status).toEqual({ state: "none" });
  });
});

describe("talent icons", () => {
  const manifest = (over: Partial<TalentIconManifest> = {}): TalentIconManifest => ({ schema: "azerdex.talent-icons/1", build: BUILD, icons: {}, ...over });
  const base = "https://assets.azerdex.com";

  it("is off unless explicitly switched to the CDN on an allow-listed https host", () => {
    expect(talentIconBase({})).toBeNull();
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "cdn" })).toBeNull(); // no asset base
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: "https://evil.example" })).toBeNull();
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: "/maps" })).toBeNull(); // same-origin = would mean committed art
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "1", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base })).toBeNull();
    expect(talentIconBase({ AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base })).toBe(base);
    expect(talentIconImgOrigin({ AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base })).toBe(base);
    expect(talentIconImgOrigin({})).toBeNull();
  });

  it("resolves URLs by build and spell id only", () => {
    const sid = byName("Penance").spellId;
    const urls = resolveTalentIcons(priest, manifest({ icons: { [sid]: 135_953 } }), base);
    expect(urls).toEqual({ [byName("Penance").id]: `${base}/talent-icons/${BUILD}/135953.webp` });
  });

  it("resolves nothing for no base, an empty or null-build manifest, or another build", () => {
    const icons = { [byName("Penance").spellId]: 1 };
    expect(resolveTalentIcons(priest, manifest({ icons }), null)).toEqual({});
    expect(resolveTalentIcons(priest, manifest({ build: null, icons }), base)).toEqual({});
    expect(resolveTalentIcons(priest, manifest({ build: "1.60.1.70532", icons }), base)).toEqual({});
    expect(resolveTalentIcons(priest, manifest(), base)).toEqual({});
  });

  it("rejects malformed file ids", () => {
    const sid = byName("Penance").spellId;
    for (const bad of [0, -1, 1.5, 2 ** 31, Number.NaN, "../x" as never]) expect(resolveTalentIcons(priest, manifest({ icons: { [sid]: bad } }), base)).toEqual({});
  });

  it("the shipped manifest resolves every talent to a versioned CDN URL only when the CDN is switched on", () => {
    expect(getTalentIcons(priest, {})).toEqual({});
    expect(getTalentIcons(priest, { AZERDEX_TALENT_ICONS: "1", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base })).toEqual({});
    for (const c of CLASSES) {
      const data = getTalentData(c, { FOREVERDB_DEPLOYMENT: "local" })!;
      const urls = getTalentIcons(data, { AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base });
      const talents = data.trees.flatMap((t) => t.talents);
      expect(Object.keys(urls), c).toHaveLength(talents.length);
      for (const t of talents) expect(urls[t.id], `${c}/${t.name}`).toBe(`${base}/talent-icons/${BUILD}/${TALENT_ICONS.icons[String(t.spellId)]}.webp`);
    }
  });

  it("refuses a manifest of another build (e.g. 70630 ids are never served as 70634)", () => {
    const icons = Object.fromEntries(Object.entries(TALENT_ICONS.icons));
    expect(resolveTalentIcons(priest, manifest({ build: "1.60.1.70630", icons }), base)).toEqual({});
  });

  it("the icon origin reaches img-src only, and only when configured", () => {
    // Compare exact source tokens per directive instead of pattern-matching the policy text.
    const directives = (csp: string) => new Map(csp.split("; ").map((d) => { const [name, ...tokens] = d.split(" "); return [name!, tokens] as const; }));
    const opts = { dev: false, turnstile: false, https: true };

    const off = directives(buildPageCsp("n", opts));
    expect(off.get("img-src")).toEqual(["'self'", "data:"]);

    const on = directives(buildPageCsp("n", { ...opts, iconImgOrigin: base }));
    expect(on.get("img-src")).toEqual(["'self'", "data:", base]);
    // Nothing else gains the origin, and the script policy is untouched.
    for (const [name, tokens] of on) if (name !== "img-src") expect(tokens, name).not.toContain(base);
    expect(on.get("connect-src")).toEqual(["'self'"]);
    expect(on.get("script-src")).toEqual(off.get("script-src"));

    // Not duplicated within img-src when the map asset origin is the same host (that origin also reaches connect-src, as before).
    const both = directives(buildPageCsp("n", { ...opts, assetOrigin: base, iconImgOrigin: base }));
    expect(both.get("img-src")!.filter((t) => t === base)).toHaveLength(1);
    expect(both.get("connect-src")).toContain(base);
  });
});

describe("TalentCard", () => {
  const engine = createEngine(priest);
  const render = (talent: ReturnType<typeof byName>, extra: Record<string, unknown> = {}, alloc = {}) =>
    renderToStaticMarkup(createElement(TalentCard, { engine, alloc, talent, tree: priest.trees[0]!, ...extra }));

  it("says so when there is no description", () => {
    expect(render(byName("Power in Light"))).toContain("No description could be verified for this game build");
  });

  it("shows build-verified text with every unresolved number as an explicit, labelled gap", () => {
    const talent = { ...byName("Power in Light"), rankText: [{ segments: ["Deals ", { g: "$m1", c: "curve" as const }, "% more damage."], complete: false }] };
    const html = render(talent);
    expect(html).toContain("Deals ");
    expect(html).toContain("% more damage.");
    expect(html).toContain('data-gap="curve"');
    expect(html).toContain('data-complete="false"');
    expect(html).toContain("marks a value that is not available");
    expect(html).not.toContain("$m1");
    expect(html).not.toContain("No description could be verified");
    // The panel explains the reason behind a collapsed "Why?"; the hover tooltip keeps only the one-line note.
    expect(html).toContain('data-testid="talent-description-gap-reasons"');
    expect(html).toContain("per-rank value is not available");
    const tip = render(talent, { variant: "tooltip" });
    expect(tip).not.toContain("talent-description-gap-reasons");
    expect(tip).not.toContain("Why?");
    expect(tip).toContain("not available for this build yet");
    expect(tip).toContain('data-gap="curve"');
  });

  it("has a clear hierarchy: name, tier and spell id, a rank summary with pips, requirements as a checklist, then the status", () => {
    const talent = byName("Silent Resolve");
    const html = render(talent, {}, { [talent.id]: 1 });
    expect(html).toContain("Silent Resolve");
    expect(html).toContain("Spell ID " + talent.spellId);
    expect(html).toContain('data-testid="rank-summary"');
    expect(html).toMatch(/Rank <!-- -->1<!-- -->\/<!-- -->3|Rank 1\/3/);
    expect(html.match(/rounded-sm/g)).toHaveLength(talent.maxRank); // one pip per rank
    expect(html).toContain('aria-label="Requirements"');
    expect(html).toContain('data-testid="talent-status"');
  });

  it("shows fully resolved text without any gap note, and the right rank of per-rank text", () => {
    const one = render({ ...byName("Power in Light"), rankText: [{ segments: ["All numbers known."], complete: true }] });
    expect(one).toContain("All numbers known.");
    expect(one).toContain('data-complete="true"');
    expect(one).not.toContain("data-gap");
    const ranks = [1, 2, 3, 4, 5].map((n) => ({ segments: [`Text for rank ${n}`], complete: true }));
    const talent = { ...byName("Power in Light"), rankText: ranks };
    const at2 = render(talent, {}, { [talent.id]: 2 });
    expect(at2).toContain("Text for rank 2");
    expect(at2).toContain("Next rank:");
    expect(at2).toContain("Text for rank 3");
    expect(at2).not.toContain("Text for rank 4");
    expect(at2).not.toContain("Text for rank 1");
    const at0 = render(talent);
    expect(at0).toContain("Rank 1:");
    expect(at0).toContain("Text for rank 1");
    expect(at0).not.toContain("Text for rank 2");
    const atMax = render(talent, {}, { [talent.id]: 5 });
    expect(atMax).toContain("Text for rank 5");
    expect(atMax).not.toContain("Next rank");
  });

  it("shows the current and next rank when per-rank text exists", () => {
    const talent = { ...byName("Power in Light"), descriptions: ["R1", "R2", "R3", "R4", "R5"] };
    const html = render(talent, {}, { [talent.id]: 2 });
    expect(html).toContain("R2");
    expect(html).toContain("Next rank:");
    expect(html).toContain("R3");
    expect(html).not.toContain("R4");
    const first = render(talent);
    expect(first).toContain("Rank 1:");
    expect(first).toContain("R1");
    const max = render(talent, {}, { [talent.id]: 5 });
    expect(max).toContain("R5");
    expect(max).not.toContain("Next rank");
    expect(html).not.toContain("not yet verified");
  });

  it("surfaces a single description", () => {
    const html = render({ ...byName("Power in Light"), description: "The one text." });
    expect(html).toContain("The one text.");
    expect(html).not.toContain("not yet verified");
  });

  it("renders text as text, never as markup", () => {
    const html = render({ ...byName("Power in Light"), description: "<img src=x onerror=alert(1)>" });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  it("includes the icon image only when a URL is given", () => {
    expect(render(byName("Power in Light"))).not.toContain("<img");
    const html = render(byName("Power in Light"), { icon: "https://assets.azerdex.com/talent-icons/x/1.webp" });
    expect(html).toContain('src="https://assets.azerdex.com/talent-icons/x/1.webp"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("NodeFace states", () => {
  const face = (state: NodeState, src?: string) => renderToStaticMarkup(createElement(NodeFace, { name: "Power in Light", src, state }));
  const icon = "https://assets.azerdex.com/talent-icons/1.60.1.70634/135972.webp";

  it("keeps the icon bright for available/in-progress/maxed, muted when no points are left, dark and locked while requirements are unmet", () => {
    for (const state of ["maxed", "partial", "available"] as const) {
      const html = face(state, icon);
      expect(html, state).not.toContain("grayscale");
      expect(html, state).not.toContain("saturate-[.6]");
      expect(html, state).not.toContain("<svg");
    }
    expect(face("waiting", icon)).toContain("saturate-[.6]");
    const locked = face("locked", icon);
    expect(locked).toContain("grayscale");
    expect(locked).toContain("<svg"); // lock glyph: the state is not carried by colour alone
  });

  it("always keeps the talent name as text, with or without an icon, and renders the icon URL unchanged", () => {
    for (const state of ["maxed", "partial", "available", "waiting", "locked"] as const) {
      expect(face(state, icon)).toContain("Power in Light");
      expect(face(state)).toContain("Power in Light");
    }
    expect(face("available", icon)).toContain(`src="${icon}"`);
    expect(face("available")).not.toContain("<img");
  });
});

describe("backdrop themes", () => {
  it("cover every class and every talent tree with a motif", () => {
    for (const c of CLASSES) {
      expect(CLASS_MOTIF[c], c).toBeTruthy();
      for (const t of getTalentData(c)!.trees) expect(TREE_MOTIF[`${c}/${t.slug}`], `${c}/${t.slug}`).toBeTruthy();
    }
    expect(Object.keys(TREE_MOTIF)).toHaveLength(27);
  });

  it("falls back to the class motif for an unknown tree", () => {
    expect(treeMotif("priest", "nope")).toBe(CLASS_MOTIF.priest);
    expect(treeMotif("nobody", "nope")).toBe("halo");
  });
});
