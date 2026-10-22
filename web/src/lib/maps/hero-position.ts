/**
 * CSP-compliant per-zone hero crop. The hero image's `object-position` used to be an inline `style` attribute, which the nonce-based
 * `style-src` (no 'unsafe-inline') blocks, so the crop never applied. The configured value (CinematicArtwork.objectPosition, e.g.
 * "85% 50%") is now mapped to a class name, and the class's declaration lives in the stylesheet (globals.css, `.hero-pos-<x>-<y>`).
 *
 * Adding or changing a zone's crop = set its `objectPosition` and add the matching `.hero-pos-<x>-<y>` rule in globals.css
 * (tests/unit/hero-position.test.ts fails if a registered position has no rule). Only whole-percent pairs are accepted, so a
 * malformed or hostile value can never become a class name or CSS.
 */
const POSITION = /^(\d{1,3})% (\d{1,3})%$/;

/** `hero-pos-85-50` for "85% 50%", or null when the value is not a plain 0–100 % pair (the caller keeps the centred default). */
export function heroPositionClass(objectPosition: string | null | undefined): string | null {
  const m = POSITION.exec(objectPosition ?? "");
  if (!m) return null;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x <= 100 && y <= 100 ? `hero-pos-${x}-${y}` : null;
}
