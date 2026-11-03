import { treeBackgroundArt } from "@/lib/classes/art";
import { CLASS_COLORS } from "@/lib/classes/colors";
import { classStyle } from "./class-style";

/**
 * Original, vector-only backdrops (project-owned; no Blizzard artwork, no raster file): a class-coloured glow and one
 * line-art motif, drawn as plain inline SVG like the Arcane Library banner. Purely decorative: aria-hidden, never
 * interactive, and kept low-contrast with a dark scrim so text and talent nodes stay readable. Owner-approved raster
 * art could replace them later through the same components (docs/web/class-guides-talents.md).
 */

export type Motif = "blades" | "claw" | "shield" | "rays" | "halo" | "arrows" | "bolt" | "waves" | "flame" | "frost" | "arcane" | "vortex" | "leaf" | "stars";

/** Decorative motif per class (hero and cards). */
export const CLASS_MOTIF: Readonly<Record<string, Motif>> = {
  warrior: "blades", paladin: "rays", hunter: "arrows", rogue: "claw", priest: "halo", shaman: "bolt", mage: "arcane", warlock: "vortex", druid: "leaf",
};

/** Decorative motif per talent tree, `<class>/<tree slug>`. Picked from the tree's name only; it says nothing about gameplay. */
export const TREE_MOTIF: Readonly<Record<string, Motif>> = {
  "warrior/arms": "blades", "warrior/fury": "claw", "warrior/protection": "shield",
  "paladin/holy": "rays", "paladin/protection": "shield", "paladin/retribution": "blades",
  "hunter/beast-mastery": "claw", "hunter/marksmanship": "arrows", "hunter/survival": "leaf",
  "rogue/assassination": "blades", "rogue/combat": "claw", "rogue/subtlety": "vortex",
  "priest/discipline": "halo", "priest/holy": "rays", "priest/shadow-magic": "vortex",
  "shaman/elemental-combat": "bolt", "shaman/enhancement": "blades", "shaman/restoration": "waves",
  "mage/arcane": "arcane", "mage/fire": "flame", "mage/frost": "frost",
  "warlock/affliction": "vortex", "warlock/demonology": "arcane", "warlock/destruction": "flame",
  "druid/balance": "stars", "druid/feral-combat": "claw", "druid/restoration": "leaf",
};

export const treeMotif = (classId: string, treeSlug: string): Motif => TREE_MOTIF[`${classId}/${treeSlug}`] ?? CLASS_MOTIF[classId] ?? "halo";

function spokes(n: number, r1: number, r2: number, alt = false) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = alt && i % 2 ? r1 + (r2 - r1) * 0.55 : r2;
    return `M${(50 + Math.cos(a) * r1).toFixed(1)} ${(50 + Math.sin(a) * r1).toFixed(1)}L${(50 + Math.cos(a) * r).toFixed(1)} ${(50 + Math.sin(a) * r).toFixed(1)}`;
  }).join("");
}

function MotifShape({ motif }: { motif: Motif }) {
  switch (motif) {
    case "blades": return <path d="M16 84L80 20M72 20H80V28M28 72L20 80M22 64L36 78M84 84L20 20M28 20H20V28M72 72L80 80M78 64L64 78" />;
    case "claw": return <path d="M26 14C34 40 40 64 34 88M46 10C56 38 62 64 56 90M66 14C74 40 78 64 74 88" />;
    case "shield": return <path d="M50 12L82 25V50C82 70 66 82 50 90C34 82 18 70 18 50V25ZM50 12V90M18 44H82" />;
    case "rays": return <><circle cx="50" cy="50" r="9" /><path d={spokes(20, 16, 46, true)} /></>;
    case "halo": return <><circle cx="50" cy="50" r="12" /><circle cx="50" cy="50" r="26" /><circle cx="50" cy="50" r="40" /><path d="M50 18L54 46L82 50L54 54L50 82L46 54L18 50L46 46Z" /></>;
    case "arrows": return <path d="M20 58L50 28L80 58M20 74L50 44L80 74M20 90L50 60L80 90M50 28V8" />;
    case "bolt": return <path d="M58 8L34 52H52L40 92L72 40H54L66 8Z" />;
    case "waves": return <path d="M8 36Q22 24 36 36T64 36T92 36M8 54Q22 42 36 54T64 54T92 54M8 72Q22 60 36 72T64 72T92 72" />;
    case "flame": return <path d="M50 10C58 30 76 40 72 62C70 78 60 90 50 90C38 90 28 78 30 62C32 48 42 44 44 30C50 38 50 24 50 10ZM50 46C55 56 62 62 60 72C59 80 55 84 50 84C45 84 41 80 41 72C41 62 48 58 50 46Z" />;
    case "frost": return <><path d={spokes(6, 6, 44)} /><path d="M50 22L44 14M50 22L56 14M50 78L44 86M50 78L56 86M26 36L16 36M26 36L22 27M74 64L84 64M74 64L78 73M26 64L16 64M26 64L22 73M74 36L84 36M74 36L78 27" /></>;
    case "arcane": return <><circle cx="50" cy="50" r="42" /><circle cx="50" cy="50" r="30" /><rect x="24" y="24" width="52" height="52" transform="rotate(45 50 50)" /><rect x="24" y="24" width="52" height="52" /></>;
    case "vortex": return <path d="M50 50a4 4 0 0 1 8 0a10 10 0 0 1-20 0a18 18 0 0 1 36 0a26 26 0 0 1-52 0a34 34 0 0 1 68 0a42 42 0 0 1-84 0" />;
    case "leaf": return <path d="M50 92V30M50 72C30 68 22 54 24 40C40 42 50 54 50 72M50 58C68 54 76 42 74 28C58 30 50 42 50 58M50 30C44 22 44 14 50 8C56 14 56 22 50 30Z" />;
    case "stars": return <><path d="M62 16A32 32 0 1 0 84 66A26 26 0 1 1 62 16Z" /><path d="M24 22V34M18 28H30M82 80V90M77 85H87M20 78V86M16 82H24" /></>;
  }
}

type Variant = "tree" | "hero" | "card";

/**
 * Per variant: the motif's own viewBox and alignment (so it keeps its proportions in a box of any shape), where the motif sits
 * inside that viewBox, its strength, and the glow. The glow is a separate full-bleed layer, so there is never a visible seam where
 * the motif's box ends.
 */
const LAYOUT: Record<Variant, { viewBox: string; align: string; place: string; motif: string; glow: number; stroke: number; glowAt: string }> = {
  // Tall talent panel: motif centred in a tall box, very faint.
  tree: { viewBox: "0 0 100 170", align: "xMidYMid meet", place: "translate(8 38) scale(0.84)", motif: "opacity-[0.15]", glow: 0.18, stroke: 1.2, glowAt: "50% 22%" },
  // Class page header: an ornament on the right-hand side.
  hero: { viewBox: "0 0 100 100", align: "xMaxYMid meet", place: "translate(8 8) scale(0.84)", motif: "opacity-[0.16]", glow: 0.26, stroke: 0.9, glowAt: "86% 45%" },
  // Class card: cropped into the lower-right corner.
  card: { viewBox: "0 0 100 100", align: "xMaxYMax slice", place: "translate(48 42) scale(0.62)", motif: "opacity-[0.13]", glow: 0.2, stroke: 0.9, glowAt: "80% 85%" },
};

export function ClassBackdrop({ classId, motif, variant, uid }: { classId: string; motif: Motif; variant: Variant; uid: string }) {
  const hex = CLASS_COLORS[classId] ?? "#D9B978";
  const l = LAYOUT[variant];
  const gid = `bd-${uid}`;
  const [gx, gy] = l.glowAt.split(" ");
  return (
    <div aria-hidden="true" data-testid={`backdrop-${variant}`} data-motif={motif} className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
      {/* Soft class-coloured glow, stretched over the whole box. */}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false" className="absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id={gid} cx={gx} cy={gy} r="70%">
            <stop offset="0%" stopColor={hex} stopOpacity={l.glow} />
            <stop offset="100%" stopColor={hex} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#${gid})`} />
      </svg>
      {/* Line-art motif, in the class colour at low strength. */}
      <svg viewBox={l.viewBox} preserveAspectRatio={l.align} focusable="false" className="absolute inset-0 h-full w-full">
        <g transform={l.place} fill="none" stroke="currentColor" strokeWidth={l.stroke} strokeLinecap="round" strokeLinejoin="round" className={`${classStyle(classId).glyph} ${l.motif}`}>
          <MotifShape motif={motif} />
        </g>
      </svg>
      {/* Dark scrim keeps copy and nodes readable whatever the motif underneath. */}
      <div className={`absolute inset-0 ${variant === "hero" ? "bg-gradient-to-r from-ink-950/70 via-ink-950/30 to-transparent" : variant === "card" ? "bg-gradient-to-b from-transparent to-ink-950/50" : "bg-ink-950/30"}`} />
    </div>
  );
}

/**
 * Backdrop for a talent tree panel. The vector backdrop (themed by the tree) is always rendered; when the tree has an approved
 * illustration (see TREE_BACKGROUNDS) it is laid over it, behind a dark scrim that keeps the nodes, connectors and badges
 * readable. If the image is missing or fails to load, the vector backdrop shows through unchanged.
 */
export function TreeBackdrop({ classId, treeSlug }: { classId: string; treeSlug: string }) {
  const art = treeBackgroundArt(classId, treeSlug);
  return (
    <>
      <ClassBackdrop classId={classId} motif={treeMotif(classId, treeSlug)} variant="tree" uid={`${classId}-${treeSlug}`} />
      {art && (
        <div aria-hidden="true" data-testid="backdrop-photo" data-tree={`${classId}/${treeSlug}`} className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
          {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; plain srcset keeps the page CSP (no inline styles) */}
          <img
            src={art.src}
            srcSet={art.srcSet}
            sizes="(min-width: 1024px) 420px, (min-width: 640px) 400px, 352px"
            alt=""
            aria-hidden="true"
            width={900}
            height={1200}
            loading="lazy"
            decoding="async"
            draggable={false}
            data-testid="backdrop-photo-image"
            className="absolute inset-0 h-full w-full object-cover object-[50%_35%]"
          />
          {/* Scrim: even darkening so icons and lines keep their contrast, heavier behind the tree itself. */}
          <div className="absolute inset-0 bg-ink-950/55" />
          <div className="absolute inset-0 bg-gradient-to-b from-ink-950/35 via-transparent to-ink-950/40" />
        </div>
      )}
    </>
  );
}
