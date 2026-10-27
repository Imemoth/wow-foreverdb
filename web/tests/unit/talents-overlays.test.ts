import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLASS_MOTIF, TREE_MOTIF, treeMotif } from "@/components/classes/backdrops";
import { TalentCard } from "@/components/talents/TalentCard";
import { CLASS_COLORS } from "@/lib/classes/colors";
import { createEngine } from "@/lib/talents/engine";
import { resolveTalentIcons, talentIconBase, talentIconImgOrigin } from "@/lib/talents/icons";
import { getTalentData, getTalentIcons, getTextStatus, TALENT_BUILD, TALENT_ICONS, TALENT_TEXT } from "@/lib/talents/registry";
import { TalentClassSchema } from "@/lib/talents/schema";
import { applyTalentText } from "@/lib/talents/text";
import type { TalentClassData, TalentIconManifest, TalentTextFile } from "@/lib/talents/types";
import { buildPageCsp } from "@/lib/security/headers";

const CLASSES = Object.keys(CLASS_COLORS);
const priest = getTalentData("priest") as TalentClassData;
const flat = priest.trees.flatMap((t) => t.talents);
const byName = (n: string) => flat.find((t) => t.name === n)!;
const BUILD = TALENT_BUILD.version;
const SOURCE = { name: "synthetic test source", reference: "unit test", extractedAt: "2026-01-01" };

const text = (over: Partial<TalentTextFile> & Pick<TalentTextFile, "talents">): TalentTextFile => ({ schema: "azerdex.talent-text/1", build: BUILD, source: SOURCE, ...over });

describe("shipped overlays are honest placeholders", () => {
  it("ships no description text and no icons, and every class reports that", () => {
    expect(TALENT_TEXT.build).toBeNull();
    expect(Object.keys(TALENT_TEXT.talents)).toHaveLength(0);
    expect(TALENT_ICONS.build).toBeNull();
    expect(Object.keys(TALENT_ICONS.icons)).toHaveLength(0);
    for (const c of CLASSES) {
      expect(getTextStatus(c)).toEqual({ state: "none" });
      expect(getTalentData(c)!.trees.every((t) => t.talents.every((x) => x.descriptions === undefined && x.description === undefined))).toBe(true);
    }
  });

  it("never mixes in an overlay from another build", () => {
    // The shipped files must be empty or stamped with the dataset build; anything else would be mismatched text presented as verified.
    expect(TALENT_TEXT.build === null || TALENT_TEXT.build === BUILD).toBe(true);
    expect(TALENT_ICONS.build === null || TALENT_ICONS.build === BUILD).toBe(true);
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

  it("the shipped build resolves no icons, even with the CDN switched on", () => {
    expect(getTalentIcons(priest, { AZERDEX_TALENT_ICONS: "cdn", NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: base })).toEqual({});
  });

  it("the icon origin reaches img-src only, and only when configured", () => {
    const opts = { dev: false, turnstile: false, https: true };
    const off = buildPageCsp("n", opts);
    expect(off).not.toContain("assets.azerdex.com");
    const on = buildPageCsp("n", { ...opts, iconImgOrigin: base });
    expect(on).toMatch(/img-src 'self' data: https:\/\/assets\.azerdex\.com;/);
    expect(on.match(/https:\/\/assets\.azerdex\.com/g)).toHaveLength(1);
    expect(on).toMatch(/connect-src 'self';/);
    expect(on).toMatch(/script-src 'self' 'nonce-n' 'strict-dynamic'/);
    // Not duplicated when the map asset origin is the same host.
    expect(buildPageCsp("n", { ...opts, assetOrigin: base, iconImgOrigin: base }).match(/https:\/\/assets\.azerdex\.com/g)).toHaveLength(2); // img-src + connect-src from the map origin
  });
});

describe("TalentCard", () => {
  const engine = createEngine(priest);
  const render = (talent: ReturnType<typeof byName>, extra: Record<string, unknown> = {}, alloc = {}) =>
    renderToStaticMarkup(createElement(TalentCard, { engine, alloc, talent, tree: priest.trees[0]!, ...extra }));

  it("says so when there is no description", () => {
    expect(render(byName("Power in Light"))).toContain("Rank descriptions are not yet verified for this game build");
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
