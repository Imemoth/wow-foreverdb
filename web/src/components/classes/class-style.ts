/**
 * Per-class accent classes. Written out as literal strings (not built from the colour at run time) so Tailwind
 * can see them, and so no inline `style` attribute is ever needed - the page CSP only allows nonce'd styles.
 * Accents are decorative; text keeps the AzerDex palette so contrast does not depend on a class colour.
 */
export interface ClassStyle {
  border: string;
  glyph: string;
  tint: string;
  bar: string;
}

export const CLASS_STYLE: Record<string, ClassStyle> = {
  warrior: { border: "border-[#C79C6E]/70", glyph: "text-[#C79C6E]", tint: "bg-[#C79C6E]/10", bar: "bg-[#C79C6E]" },
  paladin: { border: "border-[#F58CBA]/70", glyph: "text-[#F58CBA]", tint: "bg-[#F58CBA]/10", bar: "bg-[#F58CBA]" },
  hunter: { border: "border-[#ABD473]/70", glyph: "text-[#ABD473]", tint: "bg-[#ABD473]/10", bar: "bg-[#ABD473]" },
  rogue: { border: "border-[#FFF569]/70", glyph: "text-[#FFF569]", tint: "bg-[#FFF569]/10", bar: "bg-[#FFF569]" },
  priest: { border: "border-[#FFFFFF]/60", glyph: "text-[#FFFFFF]", tint: "bg-[#FFFFFF]/10", bar: "bg-[#FFFFFF]" },
  shaman: { border: "border-[#0070DE]/80", glyph: "text-[#3d9bff]", tint: "bg-[#0070DE]/15", bar: "bg-[#0070DE]" },
  mage: { border: "border-[#69CCF0]/70", glyph: "text-[#69CCF0]", tint: "bg-[#69CCF0]/10", bar: "bg-[#69CCF0]" },
  warlock: { border: "border-[#9482C9]/80", glyph: "text-[#b3a3e6]", tint: "bg-[#9482C9]/15", bar: "bg-[#9482C9]" },
  druid: { border: "border-[#FF7D0A]/70", glyph: "text-[#FF7D0A]", tint: "bg-[#FF7D0A]/10", bar: "bg-[#FF7D0A]" },
};

const FALLBACK: ClassStyle = { border: "border-gold-400/60", glyph: "text-gold-300", tint: "bg-gold-400/10", bar: "bg-gold-400" };

export const classStyle = (id: string): ClassStyle => CLASS_STYLE[id] ?? FALLBACK;
