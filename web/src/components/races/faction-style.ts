/** Literal class strings (Tailwind scans them; the page CSP forbids inline styles). Accents are decorative only. */
export const FACTION_STYLE = {
  alliance: { border: "border-[#4f8fe6]/70", text: "text-[#8fb8f5]", tint: "bg-[#4f8fe6]/10", ring: "has-[:focus-visible]:ring-[#8fb8f5]" },
  horde: { border: "border-[#d4544a]/70", text: "text-[#f09088]", tint: "bg-[#d4544a]/10", ring: "has-[:focus-visible]:ring-[#f09088]" },
} as const;
