/**
 * Deterministic medallion rotation shared by the Zones directory cards and the zone detail
 * identity banner (P2-A visual polish): the same zone name always resolves to the same medallion,
 * but neighbouring zones don't repeat one icon. Reuses three existing library medallions
 * (cartography/wayfinder/discovery, already shipped for Guides/News/Blog) - no new art, and
 * purely decorative, so it never implies a medallion depicts that specific zone's real geography.
 * Same hash-then-pick technique as components/library/CategoryBadge.tsx's accentFor().
 */
export const ZONE_MEDALLIONS = [
  "/library/medallions/cartography.webp",
  "/library/medallions/wayfinder.webp",
  "/library/medallions/discovery.webp",
] as const;

export function medallionFor(zoneName: string): string {
  let hash = 0;
  for (let i = 0; i < zoneName.length; i += 1) hash = (hash * 31 + zoneName.charCodeAt(i)) >>> 0;
  return ZONE_MEDALLIONS[hash % ZONE_MEDALLIONS.length]!;
}
