/**
 * The unified zone-atlas map experience (catalog-driven /zones, map on /zone/[id] and on source pages) is OFF by default.
 * Enabled only with AZERDEX_ZONE_MAPS=1 (Preview/local); with the variable unset every page behaves exactly as before.
 * Activating it on a Production deployment is a separate owner step (see docs/web/zone-atlas.md).
 */
export function zoneMapsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.AZERDEX_ZONE_MAPS === "1";
}

/** Routes whose CSP may include the asset origin when the zone-map experience is enabled. Everything else keeps the strict policy. */
const ZONE_MAP_ROUTES = [/^\/zone\/\d+\/?$/, /^\/creature\/-?\d+\/?$/, /^\/object\/-?\d+\/?$/, /^\/fishing\/-?\d+\/?$/];
export function isZoneMapRoute(pathname: string): boolean {
  return ZONE_MAP_ROUTES.some((r) => r.test(pathname));
}
