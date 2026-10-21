/**
 * The unified zone-atlas map experience (catalog-driven /zones, map on /zone/[id] and on source pages) is OFF by default.
 * Enabled only with AZERDEX_ZONE_MAPS=1 (Preview/local); with the variable unset every page behaves exactly as before.
 * Activating it on a Production deployment is a separate owner step (see docs/web/zone-atlas.md).
 */
import { assetOrigin } from "./asset-url";

export function zoneMapsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.AZERDEX_ZONE_MAPS === "1";
}

/** Routes that embed a zone/source map. (Informational: the CSP origin is NOT limited to these, see assetOriginForPage.) */
const ZONE_MAP_ROUTES = [/^\/zone\/\d+\/?$/, /^\/creature\/-?\d+\/?$/, /^\/object\/-?\d+\/?$/, /^\/fishing\/-?\d+\/?$/];
export function isZoneMapRoute(pathname: string): boolean {
  return ZONE_MAP_ROUTES.some((r) => r.test(pathname));
}

/**
 * The asset origin a page's Content-Security-Policy must allow in img-src/connect-src, or null.
 *
 * A CSP belongs to the DOCUMENT. Next.js client-side navigation (clicking a <Link>) never fetches a new document, so a visitor who lands
 * on ANY page (home, /zones, /database, an item ...) and then soft-navigates to a map keeps the policy of the page they first loaded. The
 * origin therefore has to be present on every HTML document whenever the zone-map experience is on, not only on the map routes (that
 * narrower rule blocked the manifest and images after a soft navigation until a hard reload). It is still the single validated origin
 * (asset-url.ts allow-list, https only, no wildcard) and only in img-src and connect-src; script-src/style-src and the nonce are untouched.
 * With AZERDEX_ZONE_MAPS unset (Production today) nothing changes. `/poc/maps/*` keeps its own, separate rule.
 */
export function assetOriginForPage(
  pathname: string,
  configuredBase: string | undefined | null,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!pathname.startsWith("/poc/maps/") && !zoneMapsEnabled(env)) return null;
  return assetOrigin(configuredBase);
}
