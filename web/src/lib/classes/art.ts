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

/**
 * Class detail hero: the same card illustration (same two files, no copy), framed as a wide banner. On desktop the picture
 * fills the right ~78% of the banner (text on the left), so the window is about 2.7:1 and only the vertical position matters;
 * on phones it fills the banner at roughly 1.1:1 and only the horizontal position matters. One `object-position` therefore
 * serves both: x steers the phone crop, y the desktop crop. Chosen so faces, weapons and spell effects stay in frame.
 */
export const HERO_ART_POSITION: Record<string, string> = {
  druid: "object-[50%_15%]", // antlered helm and casting hands
  hunter: "object-[45%_15%]", // face, drawn bow and arrow
  mage: "object-[50%_12%]", // face and both spell rings
  paladin: "object-[50%_10%]", // raised hammer and face
  priest: "object-[30%_8%]", // staff, face and casting hand
  rogue: "object-[70%_35%]", // hooded face and blades
  shaman: "object-[43%_25%]", // horned head and lightning hand
  warlock: "object-[30%_25%]", // skull face and fel hand
  warrior: "object-[90%_20%]", // face and spiked pauldron
};

/**
 * Talent tree backgrounds (owner-approved illustrations), `<class>/<tree slug>` -> file stem under `/public/tree-backgrounds/`.
 * Each tree has two encodes of one 3:4 image: `<stem>.webp` (900 px wide) and `<stem>-600.webp` (600 px wide). A tree with no
 * entry keeps its vector backdrop (the SVG layer is always rendered underneath, so it is also the fallback if an image fails).
 * All 27 trees (9 classes x 3) have an illustration; Priest was the reference implementation. The file stem is the artwork's own name
 * (e.g. `druid-feral` is the `druid/feral-combat` tree), so the key here, not the file name, is what binds an image to a tree.
 */
export const TREE_BACKGROUNDS: Readonly<Record<string, string>> = {
  "druid/balance": "druid-balance",
  "druid/feral-combat": "druid-feral",
  "druid/restoration": "druid-restoration",
  "hunter/beast-mastery": "hunter-beast-mastery",
  "hunter/marksmanship": "hunter-marksmanship",
  "hunter/survival": "hunter-survival",
  "mage/arcane": "mage-arcane",
  "mage/fire": "mage-fire",
  "mage/frost": "mage-frost",
  "paladin/holy": "paladin-holy",
  "paladin/protection": "paladin-protection",
  "paladin/retribution": "paladin-retribution",
  "priest/discipline": "priest-discipline",
  "priest/holy": "priest-holy",
  "priest/shadow-magic": "priest-shadow",
  "rogue/assassination": "rogue-assassination",
  "rogue/combat": "rogue-combat",
  "rogue/subtlety": "rogue-subtlety",
  "shaman/elemental-combat": "shaman-elemental",
  "shaman/enhancement": "shaman-enhancement",
  "shaman/restoration": "shaman-restoration",
  "warlock/affliction": "warlock-affliction",
  "warlock/demonology": "warlock-demonology",
  "warlock/destruction": "warlock-destruction",
  "warrior/arms": "warrior-arms",
  "warrior/fury": "warrior-fury",
  "warrior/protection": "warrior-protection",
};

export const treeBackgroundArt = (classId: string, treeSlug: string) => {
  const stem = TREE_BACKGROUNDS[`${classId}/${treeSlug}`];
  return stem
    ? { src: `/tree-backgrounds/${stem}.webp`, srcSet: `/tree-backgrounds/${stem}-600.webp 600w, /tree-backgrounds/${stem}.webp 900w` }
    : null;
};
