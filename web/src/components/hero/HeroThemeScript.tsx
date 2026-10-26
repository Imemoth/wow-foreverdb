/**
 * Picks the session's hero theme before the hero paints, so there is no flash of the
 * wrong theme and no server/client hydration mismatch: the server always renders the
 * plain fallback gradient (no data-hero-theme attribute), and this script sets the
 * attribute synchronously as the hero section's first child, before its background
 * layers are painted. "Session" = sessionStorage: stable for the tab, until it closes.
 *
 * Security note (fixes a CodeQL finding on an earlier revision): the script body below
 * is a FIXED, module-level string literal built only from other string literals - it
 * has no `${...}` interpolation of any value, so there is nothing for a taint/injection
 * analysis to flag in the dangerouslySetInnerHTML sink, and nothing that could become
 * unsafe if a future edit made the theme list configurable. The theme list and storage
 * key instead reach the browser through heroDataAttributes, rendered as ordinary JSX
 * string attributes - React HTML-escapes those on every render, which is a completely
 * different, safe code path from dangerouslySetInnerHTML. The script reads them back
 * from its own parent element at runtime via getAttribute()/JSON.parse(), never from
 * a value baked into the script text itself. tests/unit/hero-theme-script.test.ts
 * pins this: it fails if the script body is ever made to depend on HERO_THEMES again.
 *
 * CSP requires the exact per-request nonce (script-src 'nonce-…' 'strict-dynamic');
 * without it the browser blocks this script and the plain fallback gradient shows,
 * which is itself the required safe fallback.
 */
export const HERO_THEME_PICKER_JS =
  "(function(){try{" +
  "var el=document.currentScript.parentElement;" +
  'var themes=JSON.parse(el.getAttribute("data-hero-themes"));' +
  'var key=el.getAttribute("data-hero-key");' +
  "var v=sessionStorage.getItem(key);" +
  "if(themes.indexOf(v)<0){v=themes[Math.floor(Math.random()*themes.length)];sessionStorage.setItem(key,v);}" +
  'el.setAttribute("data-hero-theme",v);' +
  "}catch(e){}})();";

export function HeroThemeScript({ nonce }: { nonce: string | undefined }) {
  // eslint-disable-next-line react/no-danger -- audited: fixed literal, no interpolation; see module doc comment above.
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: HERO_THEME_PICKER_JS }} />;
}
