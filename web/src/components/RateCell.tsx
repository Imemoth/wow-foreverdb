import type { DropRow } from "@/lib/data/types";
import { fmtInterval, fmtRate } from "@/lib/format";

export function RateCell({ d }: { d: Pick<DropRow, "rate" | "rateLower" | "rateUpper" | "confidence"> }) {
  const interval = d.confidence === "high" || d.confidence === "medium" ? fmtInterval(d.rateLower, d.rateUpper) : null;
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={d.confidence === "insufficient" ? "text-conf-none" : "font-semibold text-parchment"}>
        {fmtRate(d.rate, d.confidence)}
        {d.confidence === "insufficient" && <span className="sr-only"> (rate hidden: too few samples)</span>}
      </span>
      {interval && <span className="text-[0.7rem] text-mist" title="95% Wilson interval">{interval}</span>}
    </span>
  );
}
