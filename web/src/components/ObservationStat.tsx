/**
 * One labeled statistic inside a mobile observation card (DropTable.tsx). Shared so every
 * card - item sources, object/node loot, creature loot at any level - presents the same
 * label/value rhythm instead of each call site reinventing its own markup.
 */
export function ObservationStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-mist/80">{label}</p>
      <div className="mt-0.5 text-sm text-parchment">{children}</div>
    </div>
  );
}
