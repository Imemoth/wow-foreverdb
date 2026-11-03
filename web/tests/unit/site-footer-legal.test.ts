import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "@/components/SiteFooter";

const root = resolve(__dirname, "../..");
const footer = renderToStaticMarkup(createElement(SiteFooter)).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("site footer legal notice", () => {
  it("keeps fan-project status, non-affiliation, trademark and attribution", () => {
    expect(footer).toContain("independent, free, non-commercial fan project")
    expect(footer).toContain("not affiliated with or endorsed by Blizzard Entertainment, Inc.");
    expect(footer).toMatch(/World of Warcraft and related names are trademarks or registered trademarks of Blizzard Entertainment, Inc\./);
    expect(footer).toMatch(/© Blizzard Entertainment, Inc\. All rights reserved/);
    expect(footer).toMatch(/Zone map images, talent and ability names, descriptions and icons come from World of Warcraft: Forever and remain Blizzard's property/);
    expect(footer).toContain("AzerDex claims no rights to them");
  });

  it("distinguishes game-derived content from illustrated artwork without ownership claims", () => {
    expect(footer).toMatch(/Class and race illustrations, class emblems, talent tree backgrounds and homepage artwork are not game assets/);
    expect(footer).not.toMatch(/AzerDex's own|owned by AzerDex|copyright AzerDex|all rights reserved by AzerDex/i);
  });

  it("states the owner-approved designation: independent, free, non-commercial fan project (not to be reworded without owner approval)", () => {
    expect(footer).toContain("AzerDex is an independent, free, non-commercial fan project and is not affiliated with or endorsed by Blizzard Entertainment, Inc.");
    // /about/data carries the same owner-approved designation.
    expect(readFileSync(join(root, "src/app/about/data/page.tsx"), "utf8")).toContain("is an independent, free, non-commercial fan site and is not affiliated with or endorsed by Blizzard Entertainment.");
  });

  it("links to /addon-companion and never to the obsolete /download", () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('href="/addon-companion"');
    expect(html).not.toContain('href="/download"');
  });
});

describe("public navigation sources", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  const rel = (p: string) => p.slice(root.length + 1);

  it("no component or page outside the /download page links to /download", () => {
    const offenders = walk(join(root, "src"))
      .filter((p) => !rel(p).startsWith("src/app/download/") && !rel(p).startsWith("src/components/download/") && !rel(p).startsWith("src/lib/download/"))
      .filter((p) => !["src/app/sitemap.ts"].includes(rel(p)))
      .filter((p) => /href=["'{`]+\/download["'`]|href: ?["'`]\/download["'`]/.test(readFileSync(p, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("/download and /addon-companion both keep their own canonical URL; /download stays in the sitemap", () => {
    expect(readFileSync(join(root, "src/app/download/page.tsx"), "utf8")).toContain('alternates: { canonical: "/download" }');
    expect(readFileSync(join(root, "src/app/addon-companion/page.tsx"), "utf8")).toContain('alternates: { canonical: "/addon-companion" }');
    expect(readFileSync(join(root, "src/app/sitemap.ts"), "utf8")).toContain('"/download"');
  });
});
