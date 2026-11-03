import type { AbilityView } from "@/lib/races/types";
import { EVIDENCE_LABEL } from "@/lib/races/format";
import type { Evidence } from "@/lib/versioned/types";
import { SourceLinks } from "./SourceLinks";

const FIELD_LABEL: Record<string, string> = { description: "Effect", cooldown: "Cooldown", duration: "Duration", details: "Notes", communityNotes: "Community notes" };

/**
 * One racial ability. Active/passive is a text label plus a distinct border accent. There is no icon: AzerDex has no licensed
 * race-ability artwork, so a neutral glyph tile stands in (decorative, aria-hidden).
 */
export function AbilityCard({ ability }: { ability: AbilityView }) {
  const isActive = ability.type === "active";
  const shown = (["description", "cooldown", "duration", "details", "communityNotes"] as const).filter((k) => {
    const v = ability[k];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });
  return (
    <li className={`panel flex flex-col gap-3 border-l-4 p-5 ${isActive ? "border-l-violet-400" : "border-l-gold-400"}`} data-testid={`ability-${ability.id}`} data-ability-type={ability.type}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-ink-600 bg-ink-900 font-[family-name:var(--font-display)] text-lg ${isActive ? "text-violet-300" : "text-gold-300"}`}>
          {ability.name.charAt(0)}
        </span>
        <div className="min-w-0">
          <h4 className="font-[family-name:var(--font-display)] text-xl font-semibold text-gold-300">{ability.name}</h4>
          <p className={`text-xs font-semibold uppercase tracking-wider ${isActive ? "text-violet-300" : "text-gold-400"}`}>{isActive ? "Active ability" : "Passive trait"}</p>
        </div>
      </div>
      <p className="text-parchment">{ability.description}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-mist">Cooldown</dt>
          <dd className="text-parchment" data-testid="cooldown">{isActive ? ability.cooldown ?? "Not documented" : "Not applicable"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-mist">Duration</dt>
          <dd className="text-parchment" data-testid="duration">{isActive ? ability.duration ?? "Not documented" : "Not applicable"}</dd>
        </div>
      </dl>
      {ability.details.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-parchment/90" aria-label={`Details for ${ability.name}`}>
          {ability.details.map((d) => <li key={d}>{d}</li>)}
        </ul>
      )}
      {ability.communityNotes.length > 0 && (
        <div className="rounded-lg border border-conf-low/30 bg-conf-low/5 p-3 text-sm text-[#f5d2b4]">
          <p className="text-xs font-semibold uppercase tracking-wide">Community-reported (not published by Blizzard)</p>
          <ul className="mt-1 list-disc pl-5">{ability.communityNotes.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      )}
      <p className="text-xs text-mist" data-testid="ability-evidence">
        <span className="font-semibold text-parchment/90">Backing: </span>
        {shown.map((k, i) => {
          const e = ability.evidence[k] as Evidence | undefined;
          return <span key={k}>{i > 0 && " · "}{FIELD_LABEL[k]} - {e ? EVIDENCE_LABEL[e] : "not documented"}</span>;
        })}
      </p>
      <SourceLinks sources={ability.sources} />
    </li>
  );
}
