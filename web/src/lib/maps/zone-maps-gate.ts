/**
 * The unified zone-atlas map experience (catalog-driven /zones, map on /zone/[id] and on source pages) is OFF by default.
 * Enabled only with AZERDEX_ZONE_MAPS=1 (Preview/local); with the variable unset every page behaves exactly as before.
 * Activating it on a Production deployment is a separate owner step (see docs/web/zone-atlas.md).
 */
import { assetOrigin, parseAssetBase } from "./asset-url";

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

/**
 * Where the cinematic zone heroes are served from. DEFAULT (anything but exactly "cdn"): the same-origin files in web/public/zones/hero
 * (the rollback path). `AZERDEX_ZONE_HERO_SOURCE=cdn` switches to `<asset host>/zone-heroes/...`, but only when the existing, validated
 * NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL is an https allow-listed host: an unset/invalid host silently keeps the same-origin files.
 * The flag is deliberately separate from the asset base (which the beta already sets for the atlas): configuring the CDN for maps must never
 * switch the heroes before the hero files are published there. Server-side only (no NEXT_PUBLIC), read per request.
 */
export function heroCdnBase(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (env.AZERDEX_ZONE_HERO_SOURCE !== "cdn") return null;
  const b = parseAssetBase(env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL);
  return b && b.startsWith("https://") ? b : null;
}

/**
 * The origin img-src (ONLY img-src) must allow for CDN-served heroes, or null. Like the map origin it has to be on every HTML document: a
 * client-side navigation keeps the CSP of the page the visitor first loaded. Null (no CSP change at all) while the hero source is local.
 */
export function heroImgOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return assetOrigin(heroCdnBase(env));
}
