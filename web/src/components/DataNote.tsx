import Link from "next/link";

export function DataNote({ children, tone = "info" }: { children: React.ReactNode; tone?: "info" | "warn" }) {
  return (
    <aside className={`flex gap-3 rounded-lg border p-3 text-sm ${tone === "warn" ? "border-conf-low/40 bg-conf-low/5 text-[#f5d2b4]" : "border-ink-600 bg-ink-850/80 text-mist"}`}>
      <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 9v5M10 6v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      <div>{children}</div>
    </aside>
  );
}

export function ObservedRateNote() {
  return (
    <DataNote>
      <strong className="text-parchment">Observed drop rate</strong> = times seen ÷ observed loots from that source and method.
      It is a sample rate from ForeverDB players, not Blizzard&apos;s drop chance; empty corpses may be under-counted.{" "}
      <Link href="/about/data#rates">How to read these numbers</Link>
    </DataNote>
  );
}
