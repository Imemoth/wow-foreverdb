import { notFound } from "next/navigation";
import { SourceDetailView } from "@/components/SourcePage";
import { pageContext } from "@/lib/page";
import type { DropRow, LocationPoint, SourceDetail, SourceVariant } from "@/lib/data/types";

/**
 * Internal Playwright-only harness for the creature page's level-aware map. The fixture dataset has no creature observed in several
 * zones, in zones without published cells, or at a level that is missing from one zone, so those states are fed here as SYNTHETIC
 * `SourceDetail`s into the SAME `SourceDetailView` the real /creature/[id] page renders (same builder, selector and map engine).
 *
 * Fail-closed: 404 unless E2E_FIXTURES_ENABLED=1 (set only by playwright.zone-maps.config.ts's webServer env, never in the real
 * app, beta or production). Always noindex.
 */
export const metadata = { robots: { index: false, follow: false } };

const drop = (level: number, id: number, name: string, observations: number): DropRow => ({
  source: { type: "creature", id: 900001, level, name: "Harness Boar", displayKind: "creature" }, item: { id, name },
  lootKind: "mob", drops: observations, quantity: observations, observations, rate: 0.5, rateLower: 0.2, rateUpper: 0.8, confidence: "medium", dominated: false,
});
const variant = (level: number, observations: number, itemName: string): SourceVariant => ({
  level, name: "Harness Boar", displayKind: "creature", totalObservations: observations, lastObservedAt: "2026-10-01T00:00:00Z", indexable: true,
  buckets: [{ lootKind: "mob", observations, confidence: "medium" }], drops: [drop(level, 700000 + level, `${itemName} L${level}`, observations)],
});
const cell = (mapId: number, level: number, x: number, y: number, observations: number): LocationPoint =>
  ({ level, lootKind: "mob", mapId, subzone: "Test Grove", x, y, observations });
const MULGORE = 1412, TIRISFAL = 1420, DUROTAR = 1411;
const zone = (mapId: number, zoneName: string, observations: number) => ({ mapId, zoneName, observations, association: "observed" as const });

const SCENARIOS: Record<string, SourceDetail> = {
  // Reference shape of /creature/268558: levels 5 and 6, observed in Mulgore, nothing publishable.
  "no-locations": { type: "creature", id: 900001, variants: [variant(5, 3, "Pelt"), variant(6, 1, "Pelt")], zones: [zone(MULGORE, "Mulgore", 4)], locations: [] },
  "multi-level": {
    type: "creature", id: 900001, variants: [variant(5, 6, "Pelt"), variant(6, 4, "Pelt")], zones: [zone(MULGORE, "Mulgore", 10)],
    locations: [cell(MULGORE, 5, 30, 40, 3), cell(MULGORE, 5, 45, 52, 3), cell(MULGORE, 6, 65, 30, 2), cell(MULGORE, 6, 75, 70, 2)],
  },
  // Level 6 was observed but has no cell that passed the threshold, level 5 has.
  "level-empty": {
    type: "creature", id: 900001, variants: [variant(5, 6, "Pelt"), variant(6, 2, "Pelt")], zones: [zone(MULGORE, "Mulgore", 8)],
    locations: [cell(MULGORE, 5, 30, 40, 3), cell(MULGORE, 5, 45, 52, 3)],
  },
  // Three zones: Mulgore (both levels), Tirisfal (level 6 only), Durotar (observed, artwork, no published cells).
  "multi-zone": {
    type: "creature", id: 900001, variants: [variant(5, 8, "Pelt"), variant(6, 9, "Pelt")],
    zones: [zone(MULGORE, "Mulgore", 8), zone(TIRISFAL, "Tirisfal Glades", 6), zone(DUROTAR, "Durotar", 3)],
    locations: [cell(MULGORE, 5, 30, 40, 3), cell(MULGORE, 5, 45, 52, 3), cell(MULGORE, 6, 65, 30, 2), cell(MULGORE, 6, 75, 70, 2),
      cell(TIRISFAL, 6, 25, 30, 2), cell(TIRISFAL, 6, 50, 50, 2), cell(TIRISFAL, 6, 75, 70, 2)],
  },
  "single-level": {
    type: "creature", id: 900001, variants: [variant(7, 6, "Pelt")], zones: [zone(MULGORE, "Mulgore", 6)],
    locations: [cell(MULGORE, 7, 30, 40, 3), cell(MULGORE, 7, 45, 52, 3)],
  },
};

export default async function CreatureMapHarness({ params, searchParams }: { params: Promise<{ scenario: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.E2E_FIXTURES_ENABLED !== "1") notFound();
  const s = SCENARIOS[(await params).scenario];
  if (!s) notFound();
  const { nonce, baseUrl } = await pageContext();
  return <SourceDetailView type="creature" s={s} nonce={nonce} baseUrl={baseUrl} searchParams={searchParams} />;
}
