import type { ReactNode } from "react";

/**
 * Smaller supporting-feature card (P2-E Phase 2) - a compact icon/title/description
 * tile, same restrained visual weight as Database's "Start browsing" tiles. `icon`
 * omitted renders a plain rune-glyph placeholder instead of forcing a mismatched icon,
 * same rule as Database's LOOT_KIND_ICON / zone/[id]'s category filters.
 */
export function SupportingFeatureCard({ icon, title, description, pending }: { icon?: string; title: string; description: ReactNode; pending?: boolean }) {
  return (
    <div className={`panel flex gap-3 p-4 ${pending ? "opacity-80" : ""}`}>
      {icon ? (
        // eslint-disable-next-line @next/next/no-img-element -- static repository asset
        <img src={icon} alt="" aria-hidden="true" className="h-9 w-9 shrink-0 object-contain" />
      ) : (
        <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ink-600 text-violet-300">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2 2 7l10 5 10-5-10-5Z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </span>
      )}
      <div>
        <p className="font-[family-name:var(--font-display)] text-sm font-semibold text-parchment">
          {title}
          {pending && <span className="ml-2 rounded-full bg-ink-800 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mist">Rolling out</span>}
        </p>
        <p className="mt-1 text-xs text-mist">{description}</p>
      </div>
    </div>
  );
}
