import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The /addon-companion "coming soon" page must stay independent of the /download implementation and must never
 * offer a download, an installer, a progress indicator or a launch date until the Addon and Companion are released.
 */
const SRC = resolve(__dirname, "../../src");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const page = read("app/addon-companion/page.tsx");

describe("/addon-companion coming-soon page", () => {
  it("is independent of the /download page, components, library and assets", () => {
    expect(page).not.toMatch(/from\s+["'][^"']*download/i);
    expect(page).not.toMatch(/["'`]\/download/);
  });

  it("offers no download, installer or release-asset links", () => {
    const hrefs = [...page.matchAll(/href=\{?["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).not.toMatch(/download|install|releases|\.exe|\.zip|\.msi/i);
    expect(page).not.toMatch(/<a\s[^>]*\bdownload\b/i);
    expect(page).not.toMatch(/\.(?:exe|msi|zip)\b/i);
  });

  it("has no progress indicator and no launch date", () => {
    expect(page).not.toMatch(/<progress|role=["']progressbar|aria-valuenow|\d+\s?%\s*(?:complete|done|loaded)/i);
    expect(page).not.toMatch(/\b(?:20\d{2}|Q[1-4]|January|February|March|April|June|July|August|September|October|November|December)\b/);
  });

  it("links back to the AzerDex database", () => {
    expect(page).toContain('href="/database"');
  });
});

describe("navigation wiring", () => {
  it("homepage CTA points at /addon-companion, not /download", () => {
    const home = read("app/page.tsx");
    expect(home).toMatch(/<Link href="\/addon-companion"[^>]*>Get the addon &amp; Companion<\/Link>/);
    expect(home).not.toMatch(/href="\/download"[^>]*>Get the addon/);
  });

  it("header, mobile menu and footer carry no Download entry", () => {
    for (const f of ["components/SiteHeader.tsx", "components/MobileNav.tsx", "components/SiteFooter.tsx"]) {
      expect(read(f), f).not.toMatch(/\/download/);
    }
  });
});
