# Hero background system

Session-rotating homepage hero (3 themes: `arcane-ruins`, `violet-moon`, `floating-city`).
See `themes.ts`, `HeroThemeScript.tsx`, `HeroBackground.tsx`, `HeroImageLayer.tsx`.

## Current state

Every theme's visible background is original SVG/gradient art in `HeroBackground.tsx`.
This is the permanent fallback, not a placeholder — it always renders and is what a
visitor sees with JavaScript off, on a slow connection, or before any photo asset exists.

## Adding the approved photo for a theme

1. Get the optimized file from the owner (already reviewed/approved artwork only — this
   repo never generates or substitutes hero art, and no reference image is committed
   here). A wide (≥1600px), compressed AVIF or WebP suits a full-bleed hero best.
2. Save it under `web/public/hero/<theme>.<ext>`.
3. In `themes.ts`, set that theme's `HERO_ASSET_SRC` entry to `/hero/<theme>.<ext>`.

Nothing else changes. `HeroImageLayer` picks it up automatically, requests only the
session's resolved theme's image (never all three), and layers it over the SVG via
`next/image` for responsive/optimized delivery. The SVG keeps rendering underneath as
the fallback for the other two themes, and for this one too if the image fails to load
or JavaScript never runs.

## Security note

`HeroThemeScript`'s inline script is a fixed string literal with no interpolated data —
see the doc comment in `HeroThemeScript.tsx` and the regression tests in
`tests/unit/hero-theme-script.test.ts`. Keep it that way: the theme list and storage key
reach the browser as ordinary (React-escaped) HTML attributes via `heroDataAttributes`,
never baked into the script text itself.
