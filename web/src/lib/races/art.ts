/**
 * Race artwork served from /public (same origin, so the page CSP needs nothing extra).
 *
 * `race-cards/<slug>.webp` (1086 px wide, the native size), `<slug>-800.webp`, `<slug>-540.webp` and `<slug>-240.webp`: the owner's ten
 * 3:4 portrait illustrations, encoded by scripts/build-race-art.mjs at the original aspect ratio (nothing is upscaled). One set of
 * files serves the race cards, the race page hero and the thumbnails on /guides. See docs/web/race-art.md.
 */
export const RACE_ART_WIDTHS = [240, 540, 800, 1086] as const;
/** The source illustrations are 1086 x 1448 (3:4). */
export const RACE_ART_SIZE = { width: 1086, height: 1448 } as const;

const file = (slug: string, w: number) => `/race-cards/${slug}${w === RACE_ART_SIZE.width ? "" : `-${w}`}.webp`;

export const raceArt = (slug: string) => ({
  /** Fallback for browsers without srcset support; also what a 1x phone card needs. */
  src: file(slug, 540),
  srcSet: RACE_ART_WIDTHS.filter((w) => w >= 540).map((w) => `${file(slug, w)} ${w}w`).join(", "),
});
/** Tiny version for the navigation thumbnails (about 40 px wide). */
export const raceThumbArt = (slug: string) => ({ src: file(slug, 240), srcSet: `${file(slug, 240)} 240w, ${file(slug, 540)} 540w` });

/**
 * Art direction for the race hero (literal class names: Tailwind must see them, and the page CSP forbids inline styles).
 * The hero picture is a wide window on a tall portrait: on desktop it is roughly 1.6:1, so only the vertical position matters
 * (it keeps the face and shoulders in frame); on phones the window is close to the image's own 3:4 shape, so almost nothing is cut.
 * Faces sit between 12% and 20% of the image height, which is what these values steer around.
 */
export const RACE_HERO_POSITION: Record<string, string> = {
  human: "object-[50%_5%]",
  dwarf: "object-[50%_8%]", // head, beard and hammer top
  "night-elf": "object-[50%_3%]", // face and feathered pauldrons
  gnome: "object-[50%_8%]", // face and raised wrench
  "high-order-skyborne": "object-[50%_3%]", // face and the top of the staff
  orc: "object-[50%_10%]",
  tauren: "object-[50%_6%]", // horns and face
  troll: "object-[50%_5%]", // crest and face
  undead: "object-[50%_10%]",
  "windshaper-skyborne": "object-[50%_4%]", // face and the staff head
};

/** Card art is shown at the image's own 3:4, so no crop is applied; this only anchors it if a card is ever slightly shorter. */
export const RACE_CARD_POSITION = "object-top";

/** `sizes` for the images above: what the browser needs to choose a file before layout. */
export const RACE_CARD_SIZES = "(min-width: 1280px) 236px, (min-width: 1024px) 380px, (min-width: 640px) 46vw, 92vw";
export const RACE_HERO_SIZES = "(min-width: 1280px) 640px, (min-width: 640px) 50vw, 100vw";
