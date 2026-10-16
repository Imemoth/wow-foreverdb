import { HERO_THEMES, HERO_THEME_STORAGE_KEY } from "./themes";

/**
 * Picks the session's hero theme before the hero paints, so there is no flash of the
 * wrong theme and no server/client hydration mismatch: the server always renders the
 * plain fallback gradient (no data-hero-theme attribute), and this script - the ONLY
 * place raw markup is emitted here, mirroring JsonLd's audited pattern - sets the
 * attribute synchronously as the hero section's first child, before its background
 * layers are painted. "Session" = sessionStorage: stable for the tab, until it closes.
 * CSP requires the exact per-request nonce (script-src 'nonce-…' 'strict-dynamic');
 * without it the browser blocks this script and the plain fallback gradient shows,
 * which is itself the required safe fallback.
 */
export function HeroThemeScript({ nonce }: { nonce: string | undefined }) {
  const themesLiteral = JSON.stringify(HERO_THEMES);
  const js = `(function(){try{var k=${JSON.stringify(HERO_THEME_STORAGE_KEY)},t=${themesLiteral},v=sessionStorage.getItem(k);if(t.indexOf(v)<0){v=t[Math.floor(Math.random()*t.length)];sessionStorage.setItem(k,v);}document.currentScript.parentElement.setAttribute("data-hero-theme",v);}catch(e){}})();`;
  // eslint-disable-next-line react/no-danger -- audited: fixed theme-picker logic only, no user data
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: js }} />;
}
