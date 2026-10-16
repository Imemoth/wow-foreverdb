import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroBackground } from "../../src/components/hero/HeroBackground";
import { HERO_THEME_PICKER_JS, HeroThemeScript } from "../../src/components/hero/HeroThemeScript";
import { HERO_THEME_STORAGE_KEY, HERO_THEMES, heroDataAttributes } from "../../src/components/hero/themes";

/**
 * Regression tests for a real CodeQL finding on an earlier revision: the inline theme
 * picker was built as a template literal interpolating HERO_THEMES/HERO_THEME_STORAGE_KEY
 * directly into the dangerouslySetInnerHTML sink. These tests pin the fix (a fixed script
 * literal + data-attribute handoff) so that pattern cannot silently come back.
 */
describe("hero theme picker script (CodeQL: no dynamic data into dangerouslySetInnerHTML)", () => {
  it("HERO_THEME_PICKER_JS is built only from string literals, with no template-literal interpolation", () => {
    // The real risk CodeQL flags is `${...}` substitution reaching the sink; this is a
    // structural guarantee, not a string-content check in the config file.
    expect(HERO_THEME_PICKER_JS).not.toMatch(/\$\{/);
  });

  it("HERO_THEME_PICKER_JS never contains the theme ids or the storage key as literal text", () => {
    for (const theme of HERO_THEMES) expect(HERO_THEME_PICKER_JS).not.toContain(theme);
    expect(HERO_THEME_PICKER_JS).not.toContain(HERO_THEME_STORAGE_KEY);
  });

  it("HERO_THEME_PICKER_JS reads its data back from the DOM, not from baked-in values", () => {
    expect(HERO_THEME_PICKER_JS).toContain("document.currentScript.parentElement");
    expect(HERO_THEME_PICKER_JS).toContain('getAttribute("data-hero-themes")');
    expect(HERO_THEME_PICKER_JS).toContain('getAttribute("data-hero-key")');
    expect(HERO_THEME_PICKER_JS).toContain("JSON.parse(");
  });

  it("is a well-formed, balanced immediately-invoked function expression", () => {
    // No eval/new Function here (this repo bans both outright, see eslint.config);
    // a balanced-delimiter check is enough to catch a malformed edit to the literal.
    expect(HERO_THEME_PICKER_JS.startsWith("(function(){")).toBe(true);
    expect(HERO_THEME_PICKER_JS.endsWith("})();")).toBe(true);
    const opens = (HERO_THEME_PICKER_JS.match(/\(/g) ?? []).length;
    const closes = (HERO_THEME_PICKER_JS.match(/\)/g) ?? []).length;
    expect(opens).toBe(closes);
    const braceOpens = (HERO_THEME_PICKER_JS.match(/\{/g) ?? []).length;
    const braceCloses = (HERO_THEME_PICKER_JS.match(/\}/g) ?? []).length;
    expect(braceOpens).toBe(braceCloses);
  });

  it("renders <script nonce> with exactly the fixed body and no dynamic markup", () => {
    const html = renderToStaticMarkup(createElement(HeroThemeScript, { nonce: "test-nonce-123" }));
    expect(html).toBe(`<script nonce="test-nonce-123">${HERO_THEME_PICKER_JS}</script>`);
    for (const theme of HERO_THEMES) expect(html).not.toContain(theme);
  });

  it("renders <script> with no nonce attribute when nonce is undefined (never omits escaping by falling back to a default)", () => {
    const html = renderToStaticMarkup(createElement(HeroThemeScript, { nonce: undefined }));
    expect(html).toBe(`<script>${HERO_THEME_PICKER_JS}</script>`);
  });

  it("heroDataAttributes carries the real theme list via a normal, React-escaped attribute, not script text", () => {
    expect(heroDataAttributes["data-hero-key"]).toBe(HERO_THEME_STORAGE_KEY);
    const parsed = JSON.parse(heroDataAttributes["data-hero-themes"]);
    expect(parsed).toEqual(HERO_THEMES);
  });

  it("HeroBackground renders .hero-bg with the data attributes and the fixed script as its first child", () => {
    const html = renderToStaticMarkup(createElement(HeroBackground, { nonce: "n1" }));
    expect(html).toContain(`data-hero-themes="${heroDataAttributes["data-hero-themes"].replace(/"/g, "&quot;")}"`);
    expect(html).toContain(`data-hero-key="${HERO_THEME_STORAGE_KEY}"`);
    // The script is .hero-bg's first child; confirm its own body (not the rest of the
    // page, which legitimately has theme ids in CSS class names) carries no theme data.
    // Index-based, not a `[^<]*` regex: HERO_THEME_PICKER_JS itself contains a literal
    // "<" (the `indexOf(v)<0` comparison), which a naive "no < until </script>" regex
    // would trip on.
    const bgDivIndex = html.indexOf('class="hero-bg"');
    expect(bgDivIndex).toBeGreaterThanOrEqual(0);
    const scriptTagStart = html.indexOf("<script");
    expect(scriptTagStart).toBeGreaterThan(bgDivIndex);
    const bodyStart = html.indexOf(">", scriptTagStart) + 1;
    const bodyEnd = html.indexOf("</script>", bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const scriptBody = html.slice(bodyStart, bodyEnd);
    expect(scriptBody).toBe(HERO_THEME_PICKER_JS);
    for (const theme of HERO_THEMES) expect(scriptBody).not.toContain(theme);
  });
});
