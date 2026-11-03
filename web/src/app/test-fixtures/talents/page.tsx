import { notFound } from "next/navigation";
import { TalentCalculator } from "@/components/talents/TalentCalculator";
import { e2eFixturesAllowed } from "@/lib/e2e-fixtures";
import priestRaw from "@/data/talents/forever/1.60.1.70634/priest.json";
import { TALENT_BUILD } from "@/lib/talents/registry";
import { applyTalentText } from "@/lib/talents/text";
import type { TalentClassData, TalentTextFile } from "@/lib/talents/types";

/**
 * Internal Playwright-only harness for the talent calculator's optional layers. The real dataset ships build-verified text with
 * gaps and no icons (none is available for the build), so this page overlays SYNTHETIC ones onto the real Priest tree to drive
 * rendering and fallback behaviour: per-rank text, a single description, a working icon, and an icon whose URL fails.
 * Everything synthetic says so in its own text. Fail-closed exactly like the other /test-fixtures pages (e2eFixturesAllowed),
 * and always noindex.
 */
export const metadata = { robots: { index: false, follow: false } };

const svg = (fill: string) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${fill}"/><text x="32" y="38" font-size="14" text-anchor="middle" fill="#000">TEST</text></svg>`).toString("base64")}`;

export default function TalentFixturePage() {
  if (!e2eFixturesAllowed()) notFound();
  // The structural data WITHOUT the shipped text, so the synthetic overlay below is the only text on this page.
  const base = priestRaw as unknown as TalentClassData;
  const id = (name: string) => base.trees.flatMap((t) => t.talents).find((x) => x.name === name)!.id;

  const text: TalentTextFile = {
    schema: "azerdex.talent-text/1",
    build: TALENT_BUILD.version,
    source: { name: "E2E synthetic fixture (not game text)", reference: "tests/e2e/talents.spec.ts", extractedAt: "2026-01-01" },
    talents: {
      [id("Power in Light")]: { descriptions: [1, 2, 3, 4, 5].map((n) => `SYNTHETIC rank ${n} text for Power in Light.`) },
      [id("Shadow Focus")]: { description: "SYNTHETIC single description for Shadow Focus." },
      // Wrong rank count: must be ignored, leaving the honest fallback.
      [id("Blackout")]: { descriptions: ["SYNTHETIC only one entry"] },
    },
  };
  const { data } = applyTalentText(base, text);
  const icons = {
    [id("Power in Light")]: svg("#9b74e6"),
    [id("Shadow Focus")]: svg("#d9b978"),
    // Same-origin URL that 404s: the node must fall back to its name plate.
    [id("Blackout")]: "/test-fixtures/missing-icon.webp",
  };

  return (
    <div className="mx-auto max-w-7xl py-6">
      <h1 className="panel-title text-xl">Talent calculator test fixture</h1>
      <p className="mb-4 mt-1 text-sm text-mist">Internal harness: synthetic descriptions and icons on the real Priest tree. Not a public page.</p>
      <TalentCalculator data={data} icons={icons} />
    </div>
  );
}
