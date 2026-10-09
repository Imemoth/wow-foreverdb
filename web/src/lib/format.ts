import type { Confidence, DisplayKind, LootKind, SourceType } from "./data/types";

export const LOOT_KIND_LABEL: Record<LootKind, string> = {
  mob: "Creature loot",
  skinning: "Skinning",
  mining: "Mining",
  herbalism: "Herbalism",
  fishing: "Fishing",
  fishing_pool: "Fishing pool",
  chest: "Chest / container",
  gameobject: "Object",
  disenchant: "Disenchanting",
};

export const DISPLAY_KIND_LABEL: Record<DisplayKind, string> = {
  item: "Item",
  creature: "Creature",
  object: "Object",
  fishing_pool: "Fishing pool",
  fishing: "Fishing zone",
};

export const DISPLAY_KIND_PLURAL: Record<DisplayKind, string> = {
  item: "Items",
  creature: "Creatures",
  object: "Objects & nodes",
  fishing_pool: "Fishing pools",
  fishing: "Fishing zones",
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High sample",
  medium: "Moderate sample",
  low: "Low sample",
  insufficient: "Too few samples",
};

const nf = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => nf.format(n);

/**
 * Observed-rate display. Precision follows the sample size: we never print
 * more digits than the data can justify, and suppressed rates show a dash.
 */
export function fmtRate(rate: number | null, confidence: Confidence): string {
  if (rate == null || confidence === "insufficient") return "—";
  const pct = rate * 100;
  if (confidence === "low") return `~${Math.round(pct)}%`;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

export function fmtInterval(lo: number | null, hi: number | null): string | null {
  if (lo == null || hi == null) return null;
  return `${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%`;
}

export function fmtAvgStack(quantity: number, drops: number): string {
  if (drops <= 0) return "—";
  const v = quantity / drops;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`;
}

export function sourceTypeLabel(type: SourceType, id: number): string {
  if (type === "creature") return "Creature";
  if (type === "fishing") return "Fishing zone";
  if (type === "item") return "Item (disenchant)";
  return id < 0 ? "Fishing pool" : "Object";
}

/** Synthetic fishing-pool IDs are internal; never show them as game IDs. */
export function displayId(type: SourceType | null, id: number): string | null {
  if (type === "gameobject" && id < 0) return null;
  return String(id);
}
