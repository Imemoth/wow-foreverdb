import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroImageLayer } from "../../src/components/hero/HeroImageLayer";
import { HERO_ASSET_SRC, HERO_THEMES } from "../../src/components/hero/themes";

describe("hero Phase 2 asset integration point", () => {
  it("HERO_ASSET_SRC has an entry for every theme, and no artwork has been substituted here", () => {
    // Fails loudly if a theme is ever added without a slot, or if a path sneaks in
    // without the accompanying owner-approved asset actually being reviewed in - this
    // repo never generates or substitutes hero artwork itself (see themes.ts doc comment).
    expect(Object.keys(HERO_ASSET_SRC).sort()).toEqual([...HERO_THEMES].sort());
    for (const theme of HERO_THEMES) expect(HERO_ASSET_SRC[theme]).toBeNull();
  });

  it("HeroImageLayer renders nothing on first (server) render, matching HeroThemeScript's no-flash guarantee", () => {
    // useEffect never runs during renderToStaticMarkup, so this is exactly what a
    // visitor's very first paint sees before any client JS executes: nothing here,
    // meaning HeroBackground's SVG/gradient art is the only thing visible - the
    // required fallback, not a loading gap.
    const html = renderToStaticMarkup(createElement(HeroImageLayer));
    expect(html).toBe("");
  });
});
