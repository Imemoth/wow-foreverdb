# Hero background system

Session-rotating homepage hero (3 themes: `arcane-ruins`, `violet-moon`, `floating-city`).
See `themes.ts`, `HeroThemeScript.tsx`, `HeroBackground.tsx`, `HeroImageLayer.tsx`.

## Current state

Every theme has an approved raster image (`public/hero/<theme>.webp`), layered over the
original SVG/gradient art in `HeroBackground.tsx`. The SVG is not a placeholder — it is
the permanent fallback, and is what a visitor sees with JavaScript off, on a slow
connection, or if the image fails to load. See `docs/azerdex-hero-art/provenance.md`
for what the three current images are, how they were generated, and the IP review that
cleared them.

## Replacing or adding a theme's photo

1. Get the optimized file from the owner (already reviewed/approved artwork only — this
   repo never generates or substitutes hero art itself). A wide (≥1600px), compressed
   WebP or AVIF suits a full-bleed hero best; this repo runs Next's image pipeline with
   `images.unoptimized: true` site-wide (`next.config.ts`, out of scope to change for
   this feature), so there is no automatic per-device resizing — size/compress the file
   itself before committing it, the way `provenance.md` records for the current three.
2. Embed a discreet AzerDex watermark into the file before it goes anywhere near
   `web/public/` — see "Embedded AzerDex watermark" in `provenance.md` for the
   existing three themes' tint/opacity/placement approach and why placement has to be
   checked against both the desktop crop (cropped top/bottom by that theme's
   `HERO_IMAGE_FOCAL`) and the mobile crop (cropped left/right, full height) before
   it's considered final. Save the watermarked result under
   `web/public/hero/<theme>.<ext>`.
3. **Do not** save an unmodified/unwatermarked copy anywhere under `web/public/` (or
   any other path this app serves) — anything under `public/` is served as a static
   file, so an "audit copy" placed there is a public download, which is exactly the
   mistake Phase 1 Task C corrected (see `provenance.md`'s "Residual git-history
   exposure" section for what that cost). Keep the unwatermarked original only in
   storage the owner controls outside this repository, and record its SHA-256 (not
   the file itself) in `provenance.md`.
4. In `themes.ts`, set that theme's `HERO_ASSET_SRC` entry to `/hero/<theme>.<ext>` and
   give it a `HERO_IMAGE_FOCAL` entry (a CSS `object-position` string) pointing at the
   image's actual focal point, not a blind `"50% 50%"` — see the existing three entries
   for the reasoning per theme.
5. Add the new provenance details (source, generation method/date if applicable, owner
   approval, SHA-256 of the private original, watermark placement, and a focused visual
   review for anything identifiably Blizzard-sourced — logos, trademarks, named
   characters, exact reproductions of a specific real location) to
   `docs/azerdex-hero-art/provenance.md`.

Nothing else changes. `HeroImageLayer` picks it up automatically and requests only the
session's resolved theme's image (never all three) — verified with a Playwright network
listener in CI/local testing, not just by reading the code. The SVG keeps rendering
underneath as the fallback for the other two themes, and for this one too if the image
fails to load or JavaScript never runs.

## Security note

`HeroThemeScript`'s inline script is a fixed string literal with no interpolated data —
see the doc comment in `HeroThemeScript.tsx` and the regression tests in
`tests/unit/hero-theme-script.test.ts`. Keep it that way: the theme list and storage key
reach the browser as ordinary (React-escaped) HTML attributes via `heroDataAttributes`,
never baked into the script text itself.
