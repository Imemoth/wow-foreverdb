"use client";

import Image from "next/image";
import { useSyncExternalStore } from "react";
import { HERO_ASSET_SRC, HERO_IMAGE_FOCAL, HERO_THEME_STORAGE_KEY, isHeroTheme, type HeroTheme } from "./themes";

// The resolved theme is written once by HeroThemeScript and never changes again for
// this tab's session (sessionStorage only), so there is nothing to subscribe to.
function subscribe() {
  return () => {};
}

function getSnapshot(): HeroTheme | null {
  try {
    const stored = sessionStorage.getItem(HERO_THEME_STORAGE_KEY);
    return isHeroTheme(stored) ? stored : null;
  } catch {
    return null; // sessionStorage unavailable (private browsing, etc.): stay on the fallback.
  }
}

function getServerSnapshot(): HeroTheme | null {
  return null; // the server never has sessionStorage - this is the required no-flash fallback.
}

/**
 * Progressive enhancement over HeroBackground's SVG/gradient layers, which remain the
 * permanent fallback underneath this. Once the browser has resolved this session's
 * theme (the same sessionStorage value HeroThemeScript writes) AND an asset is
 * configured for it in HERO_ASSET_SRC, this layers next/image over the vector art for
 * that theme only - see docs/azerdex-hero-art/provenance.md for what the three current
 * images are and how they were cleared for use.
 *
 * Note on "optimized": this repo sets `images: { unoptimized: true }` in
 * next.config.ts site-wide (pre-existing, out of scope to change here), so next/image
 * does not run its own per-device-width resizing pipeline - the file at HERO_ASSET_SRC
 * is served as-is. next/image is still used here for its fill/object-position
 * ergonomics and so this picks up that pipeline automatically if it's ever turned on
 * site-wide. The actual size/quality discipline instead happens once, up front, in the
 * asset itself - see provenance.md for the source-vs-optimized-derivative numbers.
 *
 * Reads sessionStorage via useSyncExternalStore (the correct primitive for a
 * synchronous external read like this, not a setState-in-effect) so the first client
 * render already reflects it with no extra render pass; the SSR snapshot is always
 * null, so the server-rendered output is always empty - no flash, no hydration
 * mismatch, mirroring HeroThemeScript's own guarantee. Renders nothing whenever:
 * JavaScript hasn't run yet; sessionStorage is unavailable; or no asset is configured
 * for the resolved theme. Only the session's single resolved theme's image is ever
 * requested, never all three.
 *
 * aria-hidden + pointer-events: none (via the .hero-photo-layer class) so the image is
 * purely decorative, exactly like HeroBackground's SVG layers: it can never intercept
 * clicks/taps meant for the search field, button, or any other control above it.
 */
export function HeroImageLayer() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const src = theme ? HERO_ASSET_SRC[theme] : null;
  if (!theme || !src) return null;

  return (
    <Image
      src={src}
      alt=""
      aria-hidden="true"
      fill
      priority
      sizes="100vw"
      className="hero-photo-layer"
      style={{ objectPosition: HERO_IMAGE_FOCAL[theme] }}
    />
  );
}
