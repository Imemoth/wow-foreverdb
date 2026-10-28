/**
 * Class artwork served from /public (same origin, so the page CSP needs nothing extra).
 *
 * - `class-icons/<id>.webp`: 128x128 emblems for the compact navigation on /guides.
 * - `class-cards/<id>.webp` (1024w) and `<id>-640.webp` (640w): the owner's character illustrations for the cards on
 *   /guides/classes, at the original aspect ratio (the card crops with `object-fit: cover`, steered by CARD_ART_POSITION).
 */
export const classIconPath = (id: string) => `/class-icons/${id}.webp`;

export const CARD_ART_WIDTHS = { small: 640, large: 1024 } as const;
export const classCardArt = (id: string) => ({
  src: `/class-cards/${id}.webp`,
  srcSet: `/class-cards/${id}-640.webp ${CARD_ART_WIDTHS.small}w, /class-cards/${id}.webp ${CARD_ART_WIDTHS.large}w`,
});

/**
 * Art direction: where the 4:3 card window sits on each (mostly wider) illustration, so the face, weapon and signature
 * armour stay in frame. Literal class names (Tailwind must see them; the page CSP forbids inline styles).
 */
export const CARD_ART_POSITION: Record<string, string> = {
  druid: "object-[50%_50%]", // antlered helm and outstretched hands, the bear stays in frame
  hunter: "object-[45%_50%]", // face, drawn bow and the wolf
  mage: "object-[50%_50%]",
  paladin: "object-[50%_50%]", // native 4:3, no crop
  priest: "object-[35%_50%]", // staff, face and casting hand
  rogue: "object-[70%_50%]", // hooded face and both blades
  shaman: "object-[40%_50%]",
  warlock: "object-[40%_50%]",
  warrior: "object-[58%_50%]", // face, spiked pauldrons and the axe
};
