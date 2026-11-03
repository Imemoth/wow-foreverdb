import { LOCATED_LOOT_KINDS, type LootKind } from "@/lib/data/types";
import type { SourceFocus } from "./observations";

const SOURCE = /^(creature|gameobject|fishing):(-?[1-9]\d{0,9}|0)(?::([0-9]{1,3}))?$/;

/** Initial map view requested through the URL (`?kind=mining&source=gameobject:1731`). Anything invalid is ignored, never errors. */
export function parseMapFocus(params: URLSearchParams): { kinds: ReadonlySet<LootKind>; source: SourceFocus | null } {
  const kind = params.get("kind");
  const kinds = new Set<LootKind>();
  if (kind && (LOCATED_LOOT_KINDS as readonly string[]).includes(kind)) kinds.add(kind as LootKind);
  const m = SOURCE.exec(params.get("source") ?? "");
  const source: SourceFocus | null = m
    ? { type: m[1] as SourceFocus["type"], id: Number(m[2]), level: m[3] != null ? Number(m[3]) : null }
    : null;
  return { kinds, source };
}

/** Whole-zone map URL that keeps one source in focus (the zone page understands `source`). */
export function zoneMapHref(mapId: number, source?: SourceFocus | null): string {
  const base = `/zone/${mapId}`;
  return source ? `${base}?source=${source.type}:${source.id}${source.level != null ? `:${source.level}` : ""}` : base;
}
