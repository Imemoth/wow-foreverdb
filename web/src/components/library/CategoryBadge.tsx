/**
 * Editorial categories come straight from content frontmatter (lib/content/loader.ts) - free-form
 * strings, not a fixed enum - so there is no per-category icon/taxonomy to invent. This assigns a
 * small, deterministic accent (same string always gets the same color) from the site's existing
 * token palette, purely for quick visual scanning of a mixed-category grid.
 */
const ACCENTS = [
  "border-violet-400/40 text-violet-300",
  "border-gold-500/40 text-gold-300",
  "border-kind-fishing/40 text-kind-fishing",
  "border-kind-herbalism/40 text-kind-herbalism",
  "border-bronze-400/40 text-bronze-400",
  "border-kind-disenchant/40 text-kind-disenchant",
] as const;

function accentFor(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i += 1) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  return ACCENTS[hash % ACCENTS.length]!;
}

export function CategoryBadge({ category }: { category: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${accentFor(category)}`}>
      {category}
    </span>
  );
}
