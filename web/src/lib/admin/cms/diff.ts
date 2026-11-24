import type { SnapshotOutput } from "./schemas";

export interface DiffLine { kind: "same" | "add" | "del"; text: string }

/** Line diff by longest common subsequence (article bodies are bounded, so O(n*m) is fine). */
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

export interface FieldDiff { field: string; label: string; changed: boolean; before: string; after: string }
const LABELS: [keyof SnapshotOutput, string][] = [
  ["title", "Title"], ["summary", "Summary"], ["byline", "Byline"], ["category", "Category"], ["tags", "Tags"], ["classification", "Classification"],
  ["featured", "Featured"], ["seo_description", "SEO description"], ["related_links", "Related links"],
];
const show = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.join(", ") : "—") : v === "" || v === null || v === undefined ? "—" : String(v));
export function diffSnapshots(before: SnapshotOutput, after: SnapshotOutput): FieldDiff[] {
  return LABELS.map(([f, label]) => {
    const b = show(before[f]), a = show(after[f]);
    return { field: f, label, changed: b !== a, before: b, after: a };
  });
}
