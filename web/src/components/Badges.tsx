import type { Confidence, DisplayKind, LootKind } from "@/lib/data/types";
import { CONFIDENCE_LABEL, DISPLAY_KIND_LABEL, LOOT_KIND_LABEL } from "@/lib/format";

const KIND_CLASS: Record<LootKind, string> = {
  mob: "text-kind-mob border-kind-mob/40",
  skinning: "text-kind-skinning border-kind-skinning/40",
  mining: "text-kind-mining border-kind-mining/40",
  herbalism: "text-kind-herbalism border-kind-herbalism/40",
  fishing: "text-kind-fishing border-kind-fishing/40",
  fishing_pool: "text-kind-pool border-kind-pool/40",
  chest: "text-kind-chest border-kind-chest/40",
  gameobject: "text-kind-object border-kind-object/40",
  disenchant: "text-kind-disenchant border-kind-disenchant/40",
};

export function LootKindBadge({ kind }: { kind: LootKind }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${KIND_CLASS[kind]}`}>
      {LOOT_KIND_LABEL[kind]}
    </span>
  );
}

const DISPLAY_CLASS: Record<DisplayKind, string> = {
  item: "bg-gold-500/15 text-gold-300",
  creature: "bg-kind-mob/15 text-kind-mob",
  object: "bg-kind-object/15 text-kind-object",
  fishing_pool: "bg-kind-pool/15 text-kind-pool",
  fishing: "bg-kind-fishing/15 text-kind-fishing",
};

export function DisplayKindBadge({ kind }: { kind: DisplayKind }) {
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide whitespace-nowrap ${DISPLAY_CLASS[kind]}`}>
      {DISPLAY_KIND_LABEL[kind]}
    </span>
  );
}

const CONF_CLASS: Record<Confidence, string> = {
  high: "text-conf-high",
  medium: "text-conf-medium",
  low: "text-conf-low",
  insufficient: "text-conf-none",
};
const CONF_BARS: Record<Confidence, number> = { high: 3, medium: 2, low: 1, insufficient: 0 };

export function ConfidenceBadge({ confidence, dominated }: { confidence: Confidence; dominated?: boolean }) {
  const bars = CONF_BARS[confidence];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs whitespace-nowrap ${CONF_CLASS[confidence]}`}>
      <svg viewBox="0 0 14 10" className="h-2.5 w-3.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={i * 5} y={6 - i * 3} width="4" height={4 + i * 3} rx="0.5"
            fill="currentColor" opacity={i < bars ? 1 : 0.25} />
        ))}
      </svg>
      {CONFIDENCE_LABEL[confidence]}
      {dominated && <span className="text-mist" title="Most of this sample comes from a single collector installation">· mostly one collector</span>}
    </span>
  );
}
