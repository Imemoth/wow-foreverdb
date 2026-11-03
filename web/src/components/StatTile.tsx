export function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-xs uppercase tracking-wider text-mist">{label}</p>
      <p className="mt-1 text-balance font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300 tabular-nums sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-mist">{hint}</p>}
    </div>
  );
}
