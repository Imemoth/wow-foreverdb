import type { Evidence } from "@/lib/versioned/types";
import { EVIDENCE_LABEL } from "@/lib/races/format";

const CLASS: Record<Evidence, string> = {
  "client-verified": "border-conf-high/50 text-conf-high",
  official: "border-gold-400/50 text-gold-300",
  corroborated: "border-conf-low/50 text-[#f5d2b4]",
  unverified: "border-ink-600 text-mist",
};

/** Text label (never colour alone) for how well a statement is backed. */
export function EvidenceBadge({ evidence }: { evidence: Evidence }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CLASS[evidence]}`} data-evidence={evidence}>
      {EVIDENCE_LABEL[evidence]}
    </span>
  );
}
