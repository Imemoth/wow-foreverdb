import { classStyle } from "./class-style";

const SIZE = { sm: "h-9 w-9 text-lg", md: "h-14 w-14 text-2xl", lg: "h-20 w-20 text-4xl" } as const;

/**
 * Class mark: the class initial in a ring tinted with the class colour. A deliberately plain typographic mark -
 * no bundled artwork, and no Blizzard class icons (not licensed for AzerDex).
 */
export function ClassEmblem({ classId, name, size = "md" }: { classId: string; name: string; size?: keyof typeof SIZE }) {
  const s = classStyle(classId);
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-full border-2 ${s.border} ${s.tint} ${s.glyph} ${SIZE[size]} font-[family-name:var(--font-display)] font-bold shadow-[0_0_18px_-6px_currentColor]`}
    >
      {name.charAt(0)}
    </span>
  );
}
