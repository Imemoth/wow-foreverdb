import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AbilityCard } from "@/components/races/AbilityCard";
import { ClassTile } from "@/components/classes/ClassTile";
import { RaceCard } from "@/components/races/RaceCard";
import { RaceHero } from "@/components/races/RaceHero";
import { RaceGuidesEntry } from "@/components/races/RaceGuidesEntry";
import { VersionHistory } from "@/components/races/VersionHistory";
import { CLASSES, classPath } from "@/lib/classes/classes";
import { CHANGE_LABEL, EVIDENCE_LABEL, formatDate } from "@/lib/races/format";
import { RACE_GUIDES, getRaceGuide } from "@/lib/races/registry";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const orc = getRaceGuide("orc")!;
const human = getRaceGuide("human")!;

describe("race UI components", () => {
  it("formats dates without time zone or locale drift", () => {
    expect(formatDate("2026-10-26")).toBe("26 Oct 2026");
    expect(formatDate("2026-09-02")).toBe("2 Sep 2026");
    expect(formatDate("garbage")).toBe("garbage");
  });

  it("labels every evidence level and change type in words", () => {
    expect(Object.values(EVIDENCE_LABEL).every((l) => l.length > 5)).toBe(true);
    expect(CHANGE_LABEL.documented).toBe("Community detail");
  });

  it("an active ability card shows cooldown/duration and an 'Active ability' label; a passive one says not applicable", () => {
    const active = html(createElement(AbilityCard, { ability: orc.active[0]! }));
    expect(active).toContain("Active ability");
    expect(active).toContain("2 min");
    expect(active).toContain('data-ability-type="active"');
    const passive = html(createElement(AbilityCard, { ability: orc.passive[1]! }));
    expect(passive).toContain("Passive trait");
    expect(passive).toContain("Not applicable");
    expect(passive).toContain('data-ability-type="passive"');
  });

  it("shows 'Not documented' for an unpublished cooldown and labels community details", () => {
    const wts = html(createElement(AbilityCard, { ability: human.active[0]! }));
    expect(wts).toContain("Not documented");
    const stone = html(createElement(AbilityCard, { ability: getRaceGuide("dwarf")!.active[0]! }));
    expect(stone).toContain("Community-reported (not published by Blizzard)");
    expect(stone).toContain("Blizzard-documented");
  });

  it("source links open safely in a new tab and name the source and date", () => {
    const out = html(createElement(AbilityCard, { ability: orc.active[0]! }));
    expect(out).toMatch(/<a [^>]*href="https:\/\/[^"]+"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    expect(out).toContain("(15 Oct 2026)");
  });

  it("the version history is a closed native <details> with a labelled summary and ordered rows", () => {
    const out = html(createElement(VersionHistory, { raceName: human.name, changes: human.changes, earliest: human.earliest }));
    expect(out).toContain("<details");
    expect(out).not.toMatch(/<details[^>]*\bopen\b/);
    expect(out).toContain("<summary");
    expect(out).toContain("(4 changes)");
    expect(out).toContain("Earlier definition:");
    expect(out.indexOf("26 Oct 2026")).toBeLessThan(out.indexOf("15 Oct 2026"));
    expect(out).toContain("Sword Specialization");
    expect(out).toContain("not necessarily the day a change");
  });

  it("an empty history explains itself", () => {
    const out = html(createElement(VersionHistory, { raceName: "Nobody", changes: [], earliest: [] }));
    expect(out).toContain("No changes have been documented for Nobody yet.");
  });

  it("race cards link to the race page with the faction and every class", () => {
    const out = html(createElement(RaceCard, { guide: orc, isNewRace: false }));
    expect(out).toContain('href="/guides/races/orc"');
    expect(out).toContain('data-faction="horde"');
    for (const c of orc.classes) expect(out).toContain(c.name);
    expect(out).toContain("new in Forever");
    const sky = html(createElement(RaceCard, { guide: getRaceGuide("windshaper-skyborne")!, isNewRace: true }));
    expect(sky).toContain("New race");
  });

  it("the Guides entry links to the overview and all ten race pages", () => {
    const out = html(createElement(RaceGuidesEntry));
    expect(out).toContain('href="/guides/races"');
    for (const g of RACE_GUIDES) expect(out).toContain(`href="/guides/races/${g.slug}"`);
  });

  it("every race card shows its own decorative illustration at the image's own 3:4 shape", () => {
    for (const g of RACE_GUIDES) {
      const out = html(createElement(RaceCard, { guide: g, isNewRace: g.slug.endsWith("skyborne") }));
      expect(out).toContain(`src="/race-cards/${g.slug}-540.webp"`);
      expect(out).toContain(`/race-cards/${g.slug}.webp 1086w`);
      expect(out).toContain('alt=""');
      expect(out).toContain('aria-hidden="true"');
      expect(out).toContain('width="1086"');
      expect(out).toContain('height="1448"');
      expect(out).toContain("aspect-[3/4]");
      expect(out).toContain('loading="lazy"');
      expect(out).not.toMatch(/style=/); // the page CSP forbids inline styles
      // Other races' pictures never leak into a card.
      for (const o of RACE_GUIDES) if (o.slug !== g.slug) expect(out).not.toContain(`/race-cards/${o.slug}`);
    }
  });

  it("the card keeps its name link stretched over the card, the faction label and the new-race and new-class markers", () => {
    const out = html(createElement(RaceCard, { guide: getRaceGuide("windshaper-skyborne")!, isNewRace: true }));
    expect(out).toContain("after:absolute");
    expect(out).toContain("Horde");
    expect(out).toContain("New race");
    const orcOut = html(createElement(RaceCard, { guide: orc, isNewRace: false }));
    expect(orcOut).toContain("Mage<span class=\"sr-only\"> (new in Forever)</span>");
    expect(orcOut).not.toContain("New race");
  });

  it("the race hero uses the matching illustration eagerly, keeps all page text outside the picture, and has per-race art direction", () => {
    for (const g of RACE_GUIDES) {
      const out = html(createElement(RaceHero, { guide: g, isNewRace: g.slug.endsWith("skyborne") }));
      expect(out).toContain(`src="/race-cards/${g.slug}-540.webp"`);
      expect(out).toContain('loading="eager"');
      expect(out.toLowerCase()).toContain('fetchpriority="high"');
      expect(out).toContain('alt=""');
      expect(out).toContain('data-testid="race-hero-art"');
      expect(out).toMatch(/object-\[50%_\d+%\]/);
      expect(out).toContain(`<h1`);
      expect(out).toContain(g.name);
      expect(out).toContain(g.summary.replace(/'/g, "&#x27;"));
      expect(out).toContain(g.faction === "alliance" ? "Alliance" : "Horde");
      expect(out).not.toMatch(/style=/);
      // Phones: the picture is a block above the text (never an absolute layer under it); from sm it moves behind and to the right.
      expect(out).toContain("aspect-[5/6]");
      expect(out).toContain("sm:absolute");
    }
    expect(html(createElement(RaceHero, { guide: getRaceGuide("high-order-skyborne")!, isNewRace: true }))).toContain("New race in Forever");
    expect(html(createElement(RaceHero, { guide: human, isNewRace: false }))).toContain("26 Oct 2026");
  });

  it("the two Skyborne factions get distinct images on cards and heroes", () => {
    const a = html(createElement(RaceHero, { guide: getRaceGuide("high-order-skyborne")!, isNewRace: true }));
    const b = html(createElement(RaceHero, { guide: getRaceGuide("windshaper-skyborne")!, isNewRace: true }));
    expect(a).toContain("/race-cards/high-order-skyborne");
    expect(a).not.toContain("windshaper");
    expect(b).toContain("/race-cards/windshaper-skyborne");
    expect(b).not.toContain("high-order");
  });

  it("the class tile reuses the existing class illustration and emblem (no copies), links the Class Guide and keeps the new-combination marker", () => {
    for (const c of CLASSES) {
      const out = html(createElement(ClassTile, { info: c, testId: `class-${c.id}`, badge: c.id === "mage" ? createElement("span", null, "New in Forever") : undefined }));
      expect(out).toContain(`src="/class-cards/${c.id}.webp"`);
      expect(out).toContain(`/class-cards/${c.id}-640.webp 640w`);
      expect(out).toContain(`src="/class-icons/${c.id}.webp"`);
      expect(out).toContain(`href="${classPath(c.id)}"`);
      expect(out).toContain('class="sr-only">class guide');
      expect(out).toContain(`data-testid="class-${c.id}"`);
      expect(out).toContain("after:absolute"); // whole tile is the link
      expect(out).not.toMatch(/style=/);
      expect(out.includes("New in Forever")).toBe(c.id === "mage");
    }
  });

  it("the Guides entry shows one thumbnail per race from the same artwork, with the race name as its label", () => {
    const out = html(createElement(RaceGuidesEntry));
    for (const g of RACE_GUIDES) {
      expect(out).toContain(`/race-cards/${g.slug}-240.webp`);
      expect(out).toContain(`aria-label="${g.name} (${g.faction === "alliance" ? "Alliance" : "Horde"}) race guide"`);
    }
    expect((out.match(/data-testid="race-thumb"/g) ?? []).length).toBe(10);
    expect(out).toContain(">High Order<");
    expect(out).toContain(">Windshaper<");
  });
});
