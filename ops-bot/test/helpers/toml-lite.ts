/**
 * Minimal TOML reader for wrangler.toml (tables, array-of-tables, strings, booleans, integers, arrays of strings).
 * Deliberately tiny and test-only: it avoids adding a dependency just to validate configuration. It throws on anything it does not understand,
 * so an unsupported construct fails the test instead of being silently skipped.
 */
export type TomlValue = string | boolean | number | TomlValue[] | { [k: string]: TomlValue };
export type TomlTable = { [k: string]: TomlValue };

function value(raw: string): TomlValue {
  const v = raw.trim();
  if (/^"([^"\\]|\\.)*"$/.test(v)) return JSON.parse(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(value);
  }
  throw new Error(`unsupported TOML value: ${v}`);
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let cur: TomlTable = root;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\s*#.*$/, "").trim();
    if (!line) continue;
    const arr = /^\[\[([A-Za-z0-9_.-]+)\]\]$/.exec(line);
    const tbl = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (arr || tbl) {
      const path = (arr ?? tbl)![1]!.split(".");
      let node: TomlTable = root;
      path.forEach((seg, i) => {
        const last = i === path.length - 1;
        if (last && arr) { const list = ((node[seg] as TomlTable[] | undefined) ?? (node[seg] = [] as unknown as TomlValue)) as unknown as TomlTable[]; const t: TomlTable = {}; list.push(t); node = t; }
        else { const existing = node[seg]; node = Array.isArray(existing) ? (existing[existing.length - 1] as TomlTable) : ((existing as TomlTable | undefined) ?? (node[seg] = {})) as TomlTable; }
      });
      cur = node;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`unsupported TOML line: ${line}`);
    cur[kv[1]!] = value(kv[2]!.replace(/\s+#.*$/, ""));
  }
  return root;
}
