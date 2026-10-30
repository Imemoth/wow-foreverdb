import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SPEC_GUIDES, getSpecGuide } from "@/components/classes/spec-guides";
import { CLASSES, classPath, getClass, getSpec, getSpecs, specPath, specSlug } from "@/lib/classes/classes";
import { SiteFooter } from "@/components/SiteFooter";
import * as facts from "@/lib/classes/facts";
import { classIntro, joinNames } from "@/lib/classes/facts";
import { getTalentData } from "@/lib/talents/registry";

describe("class registry", () => {
  it("lists the nine classes once each, alphabetically (the order of the class chooser)", () => {
    expect(CLASSES.map((c) => c.name)).toEqual(["Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"]);
    expect(CLASSES.map((c) => c.name)).toEqual([...CLASSES.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
    expect(new Set(CLASSES.map((c) => c.id)).size).toBe(9);
    for (const c of CLASSES) expect(c.color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("looks classes up safely", () => {
    expect(getClass("priest")?.name).toBe("Priest");
    expect(getClass("death-knight")).toBeNull();
    expect(getClass("__proto__")).toBeNull();
    expect(getTalentData("death-knight")).toBeNull();
    expect(getTalentData("__proto__")).toBeNull();
    expect(getTalentData("constructor")).toBeNull();
  });

  it("derives spec slugs from the tree, with an explicit alias only where the short name differs", () => {
    expect(getSpecs("priest").map((s) => s.slug)).toEqual(["discipline", "holy", "shadow"]);
    expect(specSlug("warrior", { slug: "arms" })).toBe("arms");
    expect(getSpec("priest", "shadow")?.tree.name).toBe("Shadow Magic");
    expect(getSpec("priest", "shadow-magic")).toBeNull();
    expect(getSpec("priest", "nope")).toBeNull();
    expect(getSpecs("death-knight")).toEqual([]);
  });

  it("builds stable paths", () => {
    expect(classPath("priest")).toBe("/guides/classes/priest");
    expect(specPath("priest", "shadow")).toBe("/guides/classes/priest/shadow");
  });
});

describe("class copy only states what the data supports", () => {
  it("joins names", () => {
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });

  it("describes a class from its talent data", () => {
    const text = classIntro("Priest", getTalentData("priest"));
    expect(text).toContain("Discipline, Holy and Shadow Magic");
    expect(text).toContain("51 points");
    expect(text).toContain("level 10 to level 60");
  });

  it("says plainly when a class has no verified talent data", () => {
    expect(classIntro("Gnome", null)).toMatch(/not available yet/);
  });

  it("no longer carries a technical provenance panel; the legal notices live in the site footer", () => {
    expect("talentSourceNote" in facts).toBe(false);
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    expect(footer).toMatch(/independent fan project/);
    expect(footer).not.toMatch(/non-?commercial/i);
    expect(footer).toMatch(/not affiliated with or endorsed by Blizzard Entertainment/);
    expect(footer).toMatch(/trademarks or registered trademarks of Blizzard Entertainment, Inc\./);
    expect(footer).toMatch(/Blizzard Entertainment, Inc\. All rights reserved/);
    expect(footer).toMatch(/talent and ability names, descriptions and icons/);
    expect(footer).toMatch(/claims no rights to them/);
  });
});

describe("specialization guides", () => {
  it("only exist for real class/spec pairs with talent data", () => {
    for (const key of Object.keys(SPEC_GUIDES)) {
      const [cls, spec] = key.split("/") as [string, string];
      expect(getTalentData(cls), key).not.toBeNull();
      expect(getSpec(cls, spec), key).not.toBeNull();
    }
    expect(getSpecGuide("priest", "holy")).toBeNull();
    expect(getSpecGuide("priest", "__proto__")).toBeNull();
  });

  it("Priest/Shadow renders from the data: facts present, unverifiable claims declared as such", () => {
    const guide = getSpecGuide("priest", "shadow")!;
    const data = getTalentData("priest")!;
    const tree = getSpec("priest", "shadow")!.tree;
    const html = renderToStaticMarkup(createElement(guide.Body, { data, tree, calculator: createElement("div", { id: "calc-slot" }) }));

    for (const heading of ["Overview", "Talents", "Beginner guide", "What is a Shadow Priest?"]) expect(html).toContain(heading);
    expect(html).toContain('id="calc-slot"');
    expect(html).toContain("Shadowform");
    expect(html).toContain("Vampiric Embrace");
    expect(html).toContain("30 points"); // last-tier gate, computed
    expect(html).toContain("21 of your 51 points"); // 51 - 30, computed
    expect(html).toContain("Not verified yet.");
    expect(html).toMatch(/not been confirmed in the Forever client/);
    // Every talent of the tree appears in the table.
    for (const t of tree.talents) expect(html).toContain(t.name.replace(/&/g, "&amp;"));
  });
});
