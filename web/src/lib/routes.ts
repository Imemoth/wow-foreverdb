import type { EntityRef, SourceType } from "./data/types";

/**
 * Canonical, type-aware entity URLs. Source identity (type, id, level) is
 * collision-safe: the type is part of the path and every level variant is a
 * separate, anchored section on its source page (never merged).
 */
export function sourcePath(type: SourceType, id: number, level?: number | null): string {
  const anchor = level != null && type === "creature" ? `#level-${level}` : "";
  switch (type) {
    case "creature": return `/creature/${id}${anchor}`;
    case "gameobject": return `/object/${id}`;
    case "fishing": return `/fishing/${id}`;
    case "item": return `/item/${id}#disenchants-into`;
  }
}

export const itemPath = (id: number) => `/item/${id}`;
export const zonePath = (mapId: number) => `/zone/${mapId}`;

export function entityPath(e: Pick<EntityRef, "entityKind" | "itemId" | "sourceType" | "sourceId" | "sourceLevel">): string {
  if (e.entityKind === "item" && e.itemId != null) return itemPath(e.itemId);
  if (e.sourceType && e.sourceId != null) return sourcePath(e.sourceType, e.sourceId, e.sourceLevel);
  return "/database";
}

export function searchPath(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  // Stable parameter order keeps URLs canonical (and cache keys clean).
  for (const k of ["q", "category", "zone", "kind", "sort", "page"]) {
    const v = params[k];
    if (v == null || v === "" || (k === "sort" && v === "relevance") || (k === "page" && Number(v) === 1)) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `/database?${s}` : "/database";
}
