import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroImageLayer } from "../../src/components/hero/HeroImageLayer";
import { HERO_ASSET_SRC, HERO_IMAGE_FOCAL, HERO_THEMES } from "../../src/components/hero/themes";

const PUBLIC_DIR = join(__dirname, "../../public");

describe("hero Phase 1 approved artwork integration", () => {
  it("HERO_ASSET_SRC maps every theme to its approved /hero/<theme>.webp asset", () => {
    // Pinned exactly, not just "truthy": a mismatched mapping would silently show the
    // wrong artwork for a theme. See docs/azerdex-hero-art/provenance.md for how these
    // three assets were cleared for use.
    expect(HERO_ASSET_SRC).toEqual({
      "arcane-ruins": "/hero/arcane-ruins.webp",
      "violet-moon": "/hero/violet-moon.webp",
      "floating-city": "/hero/floating-city.webp",
    });
  });

  it("every configured asset file actually exists under public/ and is a well-formed WebP", () => {
    for (const theme of HERO_THEMES) {
      const src = HERO_ASSET_SRC[theme];
      expect(src).not.toBeNull();
      const diskPath = join(PUBLIC_DIR, src!.replace(/^\//, ""));
      expect(existsSync(diskPath), `missing asset file for ${theme}: ${diskPath}`).toBe(true);
      const bytes = readFileSync(diskPath);
      // WebP container: "RIFF" .... "WEBP" (bytes 0-3 and 8-11).
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    }
  });

  it("every theme's retained source record exists, byte-identical to what this session received", () => {
    // docs/azerdex-hero-art/provenance.md pins the exact SHA-256 of each; this just
    // confirms the files that record refers to are actually present and non-empty.
    for (const theme of HERO_THEMES) {
      const sourcePath = join(PUBLIC_DIR, "hero/source", `${theme}.source.webp`);
      expect(existsSync(sourcePath), `missing source record for ${theme}`).toBe(true);
      expect(readFileSync(sourcePath).length).toBeGreaterThan(0);
    }
  });

  it("HERO_IMAGE_FOCAL has a CSS object-position entry for every theme", () => {
    for (const theme of HERO_THEMES) {
      expect(HERO_IMAGE_FOCAL[theme]).toMatch(/^\d{1,3}% \d{1,3}%$/);
    }
  });

  it("HeroImageLayer renders nothing on first (server) render, matching HeroThemeScript's no-flash guarantee", () => {
    // useSyncExternalStore's server snapshot is always null, so this is exactly what a
    // visitor's very first paint sees before any client JS executes: nothing here,
    // meaning HeroBackground's SVG/gradient art is the only thing visible - the
    // required fallback, not a loading gap. Still true now that real assets exist.
    const html = renderToStaticMarkup(createElement(HeroImageLayer));
    expect(html).toBe("");
  });
});
