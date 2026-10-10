import { z } from "zod";
import {
  DISPLAY_KINDS,
  InvalidQueryError,
  LOOT_KINDS,
  SOURCE_TYPES,
  type SearchQuery,
  type SourceType,
  type ZoneEntityQuery,
} from "./data/types";

export const MAX_QUERY_LENGTH = 80;
export const MAX_OFFSET = 1000;
export const PAGE_SIZE = 25;
export const MAX_API_PAGE_SIZE = 50;

const queryText = z
  .string()
  .max(MAX_QUERY_LENGTH, "query_too_long")
  .transform((s) => s.normalize("NFC").replace(/\s+/g, " ").trim())
  .refine((s) => s.length !== 1, "query_too_short")
  // SQL LIKE metacharacters and control characters are never accepted.
  .refine((s) => !/[%_\\\u0000-\u001f\u007f]/.test(s), "query_invalid_characters");

const intIn = (min: number, max: number) =>
  z.string().regex(/^-?\d{1,12}$/, "not_an_integer").transform(Number).pipe(z.number().int().min(min).max(max));

const SearchParams = z
  .object({
    q: queryText.optional().default(""),
    category: z.enum(DISPLAY_KINDS).optional(),
    zone: intIn(1, 999_999).optional(),
    kind: z.enum(LOOT_KINDS).optional(),
    sort: z.enum(["relevance", "name", "observations"]).optional().default("relevance"),
    page: intIn(1, 1000).optional().default("1" as never),
    limit: intIn(1, MAX_API_PAGE_SIZE).optional(),
  })
  .strict();

export type ParseMode = "strict" | "lenient";

/** Convert URLSearchParams into a plain object; repeated keys are rejected. */
function toRecord(params: URLSearchParams, allowed: readonly string[], mode: ParseMode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    if (!allowed.includes(k)) {
      if (mode === "strict") throw new InvalidQueryError(`unknown_parameter`);
      continue;
    }
    if (k in out) throw new InvalidQueryError("duplicate_parameter");
    if (v === "" && k !== "q") continue;
    out[k] = v;
  }
  return out;
}

export function parseSearchQuery(params: URLSearchParams, mode: ParseMode, defaultPageSize = PAGE_SIZE): SearchQuery {
  const rec = toRecord(params, ["q", "category", "zone", "kind", "sort", "page", "limit"], mode);
  const r = SearchParams.safeParse(rec);
  if (!r.success) throw new InvalidQueryError(r.error.issues[0]?.message ?? "invalid_parameters");
  const pageSize = r.data.limit ?? defaultPageSize;
  const page = Number(r.data.page);
  if ((page - 1) * pageSize > MAX_OFFSET) throw new InvalidQueryError("page_out_of_range");
  const q = r.data.q;
  if (q === "" && r.data.zone == null && r.data.kind == null) throw new InvalidQueryError("query_or_filter_required");
  return {
    q,
    category: r.data.category ?? null,
    zone: r.data.zone ?? null,
    kind: r.data.kind ?? null,
    sort: r.data.sort,
    page,
    pageSize,
  };
}

/** True when the visitor has not asked for anything yet (show the hub, not an error). */
export function isEmptySearch(params: URLSearchParams): boolean {
  for (const k of ["q", "zone", "kind"]) if ((params.get(k) ?? "").trim() !== "") return false;
  return true;
}

const ZoneParams = z
  .object({
    q: queryText.optional().default(""),
    type: z.enum(DISPLAY_KINDS).optional(),
    kind: z.enum(LOOT_KINDS).optional(),
    page: intIn(1, 100).optional().default("1" as never),
  })
  .strict();

export function parseZoneEntityQuery(mapId: number, params: URLSearchParams, mode: ParseMode): ZoneEntityQuery {
  const rec = toRecord(params, ["q", "type", "kind", "page"], mode);
  const r = ZoneParams.safeParse(rec);
  if (!r.success) throw new InvalidQueryError(r.error.issues[0]?.message ?? "invalid_parameters");
  const page = Number(r.data.page);
  const pageSize = 50;
  if ((page - 1) * pageSize > 2000) throw new InvalidQueryError("page_out_of_range");
  return { mapId, displayKind: r.data.type ?? null, lootKind: r.data.kind ?? null, q: r.data.q, page, pageSize };
}

/** Route ID parsing: canonical decimal only (no leading zeros, no "+", no whitespace). */
export function parseEntityId(raw: string, opts: { allowNegative?: boolean } = {}): number | null {
  const re = opts.allowNegative ? /^(0|-?[1-9]\d{0,9})$/ : /^[1-9]\d{0,8}$/;
  if (!re.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseSourceType(raw: string): SourceType | null {
  return (SOURCE_TYPES as readonly string[]).includes(raw) ? (raw as SourceType) : null;
}
