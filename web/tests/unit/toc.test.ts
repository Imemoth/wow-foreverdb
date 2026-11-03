import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/Markdown";
import { extractGuideToc, slugifyHeading } from "@/lib/content/toc";

describe("slugifyHeading", () => {
  it("lowercases, hyphenates and strips punctuation", () => {
    expect(slugifyHeading("Why it is not \"the\" drop chance")).toBe("why-it-is-not-the-drop-chance");
    expect(slugifyHeading("Sample size labels")).toBe("sample-size-labels");
    expect(slugifyHeading("1. Install the addon")).toBe("1-install-the-addon");
  });
  it("never returns an empty id", () => {
    expect(slugifyHeading("")).toBe("section");
    expect(slugifyHeading("***")).toBe("section");
  });
});

describe("extractGuideToc", () => {
  // GuideArticle.tsx only renders the "In this guide" nav when extractGuideToc(...).length >= 2 -
  // a single-section guide gets no (trivial, one-link) table of contents. Every current sample
  // guide happens to have 2+ H2 headings, so this threshold has no real-content e2e coverage;
  // this unit test is what actually exercises it.
  it("returns fewer than 2 entries for a guide with at most one heading (the UI hides the TOC)", () => {
    expect(extractGuideToc("Just a single intro paragraph, no headings at all.\n").length).toBeLessThan(2);
    expect(extractGuideToc("intro\n\n## Only section\n\nmore text\n").length).toBeLessThan(2);
  });

  it("extracts only H2 headings, in document order", () => {
    const md = "intro\n\n## First\n\ntext\n\n### Not extracted (H3)\n\n## Second\n";
    expect(extractGuideToc(md)).toEqual([
      { id: "first", text: "First" },
      { id: "second", text: "Second" },
    ]);
  });
  it("ignores headings inside fenced code blocks", () => {
    const md = "## Real heading\n\n```text\n## not a heading\n```\n\n## Another real heading\n";
    expect(extractGuideToc(md)).toEqual([
      { id: "real-heading", text: "Real heading" },
      { id: "another-real-heading", text: "Another real heading" },
    ]);
  });
  it("disambiguates duplicate heading text deterministically", () => {
    const md = "## Setup\n\n## Setup\n\n## Setup\n";
    expect(extractGuideToc(md).map((t) => t.id)).toEqual(["setup", "setup-2", "setup-3"]);
  });
  it("strips inline markdown (bold/code/links) from the plain-text form", () => {
    const md = "## **Bold** and `code` and [a link](/x)\n";
    expect(extractGuideToc(md)).toEqual([{ id: "bold-and-code-and-a-link", text: "Bold and code and a link" }]);
  });
});

describe("TOC ids match the ids Markdown actually renders (cross-check, real content)", () => {
  const dir = join(process.cwd(), "content", "guides");
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  it("found the expected sample guide files", () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });
  for (const file of files) {
    it(`${file}: every extractGuideToc id exists as a rendered h2 id, in the same order`, () => {
      const raw = readFileSync(join(dir, file), "utf8");
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      const toc = extractGuideToc(body);
      const html = renderToStaticMarkup(Markdown({ source: body }));
      const renderedIds = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
      expect(renderedIds).toEqual(toc.map((t) => t.id));
    });
  }
});
