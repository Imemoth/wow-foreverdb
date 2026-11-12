import type { ArticleSnapshot } from "./types";

export interface DiffLine { kind: "same" | "add" | "del"; text: string }

/** Line diff by longest common subsequence. Bodies are small (<= a few hundred lines), so O(n*m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: "same", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ kind: "del", text: a[i]! }); i++; }
    else { out.push({ kind: "add", text: b[j]! }); j++; }
  }
  while (i < n) out.push({ kind: "del", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

export interface FieldDiff { field: keyof ArticleSnapshot; label: string; changed: boolean; before: string; after: string }
const LABELS: Record<keyof ArticleSnapshot, string> = {
  title: "Title", summary: "Summary", body: "Body", byline: "Byline", category: "Category", tags: "Tags",
  classification: "Classification", featured: "Featured", coverMediaId: "Cover media", coverAlt: "Cover alt text", seoDescription: "SEO description",
};
const show = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : v === null || v === "" ? "—" : String(v));

export function diffSnapshots(before: ArticleSnapshot, after: ArticleSnapshot): FieldDiff[] {
  return (Object.keys(LABELS) as (keyof ArticleSnapshot)[]).map((field) => {
    const b = show(before[field]), a = show(after[field]);
    return { field, label: LABELS[field], changed: b !== a, before: b, after: a };
  });
}
