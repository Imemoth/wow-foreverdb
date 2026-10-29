import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AbilityCard } from "@/components/races/AbilityCard";
import { RaceCard } from "@/components/races/RaceCard";
import { RaceGuidesEntry } from "@/components/races/RaceGuidesEntry";
import { VersionHistory } from "@/components/races/VersionHistory";
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
});
