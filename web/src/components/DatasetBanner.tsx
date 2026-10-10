import Link from "next/link";
import type { DatasetMeta } from "@/lib/data/types";
import { fmtDateTime } from "@/lib/format";

/** Always-visible honesty banner. The synthetic variant cannot be dismissed. */
export function DatasetBanner({ meta }: { meta: DatasetMeta }) {
  if (meta.mode === "synthetic-sample") {
    return (
      <div role="note" className="border-b border-conf-low/40 bg-[#2a1a0e] text-sm text-[#ffd9b8]">
        <p className="mx-auto max-w-7xl px-4 py-2">
          <strong className="font-semibold">Preview with synthetic sample data.</strong> Every database figure on this
          build is invented test data produced by the publication pipeline — not real ForeverDB observations.{" "}
          <Link href="/about/data#preview" className="text-[#ffe7c9] underline">Why?</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="border-b border-ink-700/60 bg-ink-900/70 text-xs text-mist">
      <p className="mx-auto max-w-7xl px-4 py-1.5">
        Observed data · publication #{meta.publicationId ?? "–"} · published {fmtDateTime(meta.publishedAt)} ·{" "}
        <Link href="/about/data">percentages are observed sample rates</Link>
      </p>
    </div>
  );
}
