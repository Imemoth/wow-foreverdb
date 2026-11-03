/**
 * Deterministic heading-id derivation shared between the guide reader's table of contents
 * (extractGuideToc, run over the raw Markdown source) and Markdown.tsx's own `h2` renderer (run
 * over the parsed React children at render time). Both sides call slugifyHeading() on the SAME
 * plain-text extraction of a heading's content, in the SAME document order, with the SAME
 * duplicate-disambiguation counter, so a TOC `href="#slug"` always matches the heading's rendered
 * `id` - see tests/unit/toc.test.ts, which renders real guide content and asserts the two agree.
 */

/** Lowercase, hyphenated, ASCII-only id. Never empty (falls back to "section"). */
export function slugifyHeading(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** Strips common inline Markdown syntax to the plain text a reader would see. */
function markdownInlineToText(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

export interface TocEntry {
  id: string;
  text: string;
}

/** A fresh counter per call, so disambiguation ("section", "section-2", ...) starts clean for every document. */
function dedupe() {
  const seen = new Map<string, number>();
  return (base: string): string => {
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  };
}

export function createHeadingIdAssigner() {
  const next = dedupe();
  return (text: string) => next(slugifyHeading(markdownInlineToText(text)));
}

/**
 * H2-only (the only heading depth any current guide uses; see arcane-cartography-phase2a.md's
 * precedent for scoping a round to what the content actually needs). Skips fenced code blocks so
 * a `## ` inside an example never becomes a phantom chapter.
 */
export function extractGuideToc(markdown: string): TocEntry[] {
  const assignId = createHeadingIdAssigner();
  const toc: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const text = markdownInlineToText(m[1]!);
    toc.push({ id: assignId(m[1]!), text });
  }
  return toc;
}
