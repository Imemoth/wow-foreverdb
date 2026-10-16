"use client";

import Image from "next/image";
import { useSyncExternalStore } from "react";
import { HERO_ASSET_SRC, HERO_THEME_STORAGE_KEY, isHeroTheme, type HeroTheme } from "./themes";

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
 * Phase 2 integration point: progressive enhancement over HeroBackground's SVG/gradient
 * layers, which remain the permanent fallback underneath this. Once the browser has
 * resolved this session's theme (the same sessionStorage value HeroThemeScript writes)
 * AND an owner-approved asset is configured for it in HERO_ASSET_SRC, this swaps in an
 * optimized, responsive <Image> on top of the vector art for that theme only.
 *
 * Reads sessionStorage via useSyncExternalStore (the correct primitive for a synchronous
 * external read like this, not a setState-in-effect) rather than a useEffect, so the
 * first client render already reflects it with no extra render pass; the SSR snapshot
 * is always null, so the server-rendered output is always empty - no flash, no
 * hydration mismatch, mirroring HeroThemeScript's own guarantee. Renders nothing
 * whenever: JavaScript hasn't run yet; sessionStorage is unavailable; or no asset is
 * configured yet for the resolved theme (true for all three today - see
 * HERO_ASSET_SRC). Only the session's single resolved theme's image is ever requested,
 * never all three, so adding real artwork later cannot regress the hero's network cost.
 */
export function HeroImageLayer() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const src = theme ? HERO_ASSET_SRC[theme] : null;
  if (!src) return null;

  return <Image src={src} alt="" fill priority sizes="100vw" className="hero-photo-layer" />;
}
