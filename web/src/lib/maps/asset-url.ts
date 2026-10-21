/**
 * Map asset URL resolver. Same-origin by default; an external asset host is accepted only if it is
 * https and on the allow-list below (never an arbitrary host taken from configuration or data).
 */

export const ALLOWED_ASSET_HOSTS: readonly string[] = ["azerdex-assets.pages.dev", "assets.azerdex.com"];

/** Same-origin directory the POC assets are served from (web/public/maps). */
export const LOCAL_ASSET_BASE = "/maps";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Returns a normalised base ("/maps" or "https://host") or null when the value is not acceptable. */
export function parseAssetBase(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim();
  if (!v) return LOCAL_ASSET_BASE;
  if (v.startsWith("/")) return v.startsWith("//") || v.includes("..") || v.includes("\\") ? null : v.replace(/\/+$/, "") || null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  if (u.port || !ALLOWED_ASSET_HOSTS.includes(u.hostname)) return null;
  if (u.pathname.includes("..")) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Origin to add to CSP img-src/connect-src, or null for same-origin assets. */
export function assetOrigin(raw: string | undefined | null): string | null {
  const base = parseAssetBase(raw);
  return base && base.startsWith("https://") ? new URL(base).origin : null;
}

/** `<base>/forever/<zoneId>/<version>/<file>`. Throws on a malformed zone/version/file; falls back to same-origin on a bad base. */
export function resolveMapAssetUrl(
  base: string | undefined | null,
  zoneId: number,
  version: string,
  file: string,
): string {
  if (!Number.isInteger(zoneId) || zoneId < 1 || zoneId > 999_999) throw new Error("invalid_zone_id");
  if (!/^v\d{1,4}$/.test(version)) throw new Error("invalid_version");
  if (!SEGMENT.test(file)) throw new Error("invalid_file");
  const b = parseAssetBase(base) ?? LOCAL_ASSET_BASE;
  return `${b}/forever/${zoneId}/${version}/${file}`;
}
