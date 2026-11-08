# "World First: Level 60" editorial: cover artwork provenance

Two layers, both for `web/content/news/jokerd-team-world-first-level-60-wow-forever.md`.

## Primary cover: owner-supplied poster

Status: **owner-supplied illustration, supplied in the PR #178 follow-up request on 2026-11-08.** It is the "WORLD FIRST 60"
poster (three Mages, a Paladin with a raised warhammer, a Shaman, headline and 52 Hours / 5 Players / Level 60 badges baked
into the art). It is not a game screenshot and not a competitor image, and nothing is hotlinked.

- **Not recorded:** how it was made (generator/model, prompts) and any licence terms of that tool. The owner supplied it for this
  use; if terms or prompts are on file, add them here. This record does not guess.
- The poster's characters are illustrative; it is not evidence of the players' races (the article states races from tracker
  reports, and the Shaman is reported as a Troll).
- The master (1672x941, re-encoded as WebP q96) is kept in `docs/azerdex-world-first-art/masters/`. That directory is
  documentation only; it is not under `web/public` and is never served.
- Variants are cut by `web/scripts/content-art/export-world-first-60-poster.mjs` (crop to exact aspect, one lanczos3 resize,
  WebP q88, nothing stretched or repainted):

| File (`web/public/content-images/news/`) | Size | Used for |
| --- | --- | --- |
| `<slug>.webp` | 1920x1080 | Poster hero (shown uncropped, also used on phones), `/news` lead, JSON-LD image |
| `<slug>-card.webp` | 800x600 | Card thumbnail |
| `<slug>-social.webp` | 1200x630 | `og:image` / `twitter:image` |

Because the poster has its own headline, the article hero shows it whole with no overlay (`PosterHero`), and the HTML stat
strip is screen-reader-only there to avoid repeating the badges.

## Fallback: original code-authored scene

An original vector scene (silhouetted party under a runic moon, Arcane Explosion shockwave): no photograph, no AI raster, no
game asset. Rebuild with `cd web && node scripts/content-art/build-world-first-60-art.mjs`; files end in `-art`
(`-art`, `-art-mobile`, `-art-card`, `-art-social`). `PosterImage` stacks `<slug>-art.webp` underneath the poster, so if the
poster fails to load the hero degrades to this scene instead of a broken box. (A stacked image rather than a CSS background,
because the site CSP forbids inline style attributes.)

`web/tests/unit/world-first-article.test.ts` asserts every file exists with exactly the documented dimensions.

## Sources for the article's facts

Wowhead, Icy Veins and Warcraft Tavern coverage (linked in the article), cross-checked against Endgame Tools and Forever Guides
trackers for races and the roster. The three primary pages could not all be read in full from the authoring environment
(Icy Veins returned HTTP 403; Wowhead returned only its headline), so the final-4%-of-level-59 and Arcane Explosion details
rest on the brief and tracker summaries. Sources disagree by minutes on whose level-up landed first, so the piece presents a
joint world first and gives no exact timestamps or quotations.
