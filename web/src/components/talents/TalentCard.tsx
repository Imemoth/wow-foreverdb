import { Fragment, type ReactNode } from "react";
import { REFUSAL_TEXT, type TalentEngine } from "@/lib/talents/engine";
import { textForRank } from "@/lib/talents/text";
import { GAP_TEXT } from "@/lib/talents/tooltip";
import type { Allocation, Talent, TalentTree, TextSegment } from "@/lib/talents/types";
import { CardIcon } from "./TalentIcon";

/**
 * Description text with every unresolved number shown as an explicit, labelled "?" - never as a guessed value. The mark is a quiet
 * dotted-underline glyph (the reason is its accessible name and tooltip), so a talent with several of them stays readable.
 */
function Segments({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((g, i) =>
        typeof g === "string" ? (
          <Fragment key={i}>{g}</Fragment>
        ) : (
          <span
            key={i}
            role="img"
            aria-label={`value not available: ${GAP_TEXT[g.c]}`}
            title={GAP_TEXT[g.c]}
            data-gap={g.c}
            className="mx-px cursor-help px-0.5 font-mono font-semibold text-gold-300 underline decoration-gold-500/70 decoration-dotted underline-offset-[3px]"
          >
            ?
          </span>
        ),
      )}
    </>
  );
}

/** Filled/empty pips for the ranks of a talent (decorative; the rank is also written as text next to them). */
function RankPips({ rank, max }: { rank: number; max: number }) {
  return (
    <span aria-hidden="true" className="flex gap-0.5" data-testid="rank-pips">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`h-1.5 w-3 rounded-sm ${i < rank ? (rank >= max ? "bg-gold-300" : "bg-violet-300") : "bg-ink-700"}`} />
      ))}
    </span>
  );
}

/**
 * Tooltip/detail card for one talent. Shows only what the data holds: name, rank, tier, the real requirements with their live
 * progress, and - when the dataset carries verified rank text - the current and next rank descriptions. When it does not, it
 * says so rather than inventing text.
 *
 * Two variants: "tooltip" (hover only, narrow, one column) and "panel" (the selected talent in the bottom panel: a compact
 * header with the caller's `actions`, and a body that reads left to right - description, then requirements and status - on
 * wide screens). `expanded=false` hides the body on narrow screens only (the collapsed mobile sheet); wide screens always show it.
 */
export function TalentCard({
  engine,
  alloc,
  talent,
  tree,
  icon,
  variant = "panel",
  actions,
  dismiss,
  expanded = true,
}: {
  engine: TalentEngine;
  alloc: Allocation;
  talent: Talent;
  tree: TalentTree;
  icon?: string;
  variant?: "panel" | "tooltip";
  /** Add/Remove for the panel (after the rank on wide screens, on its own row under the name on phones). */
  actions?: ReactNode;
  /** Collapse/close controls (top right). */
  dismiss?: ReactNode;
  expanded?: boolean;
}) {
  const tooltip = variant === "tooltip";
  const rank = engine.rank(alloc, talent.id);
  const reqs = engine.requirements(alloc, talent.id);
  const points = reqs.find((r) => r.kind === "points");
  const talentReqs = reqs.filter((r): r is Extract<typeof r, { kind: "talent" }> => r.kind === "talent");
  const allOf = talentReqs.filter((r) => !r.anyOf);
  const anyOf = talentReqs.filter((r) => r.anyOf);
  const add = engine.canAdd(alloc, talent.id);
  const descriptions = talent.descriptions;
  // Text that differs per rank is shown like the game does: the current rank, then the next one ("Rank 1:" before the first point).
  const perRank = (talent.rankText?.length ?? 0) > 1;
  const shown: Array<{ label: string | null; text: NonNullable<ReturnType<typeof textForRank>> }> = [];
  if (talent.rankText) {
    if (!perRank) shown.push({ label: null, text: textForRank(talent, rank)! });
    else {
      if (rank > 0) shown.push({ label: null, text: textForRank(talent, rank)! });
      if (rank < talent.maxRank) shown.push({ label: rank > 0 ? "Next rank:" : "Rank 1:", text: textForRank(talent, rank + 1)! });
    }
  }
  const gapCodes = [...new Set(shown.flatMap((x) => x.text.segments.flatMap((g) => (typeof g === "string" ? [] : [g.c]))))];
  const maxed = rank >= talent.maxRank;
  const rankTone = maxed ? "border-gold-300/60 text-gold-300" : rank > 0 ? "border-violet-300/60 text-violet-300" : "border-ink-600 text-mist";

  const description =
    shown.length > 0 ? (
      <div className="space-y-1.5" data-testid="talent-description" data-complete={shown.every((x) => x.text.complete) ? "true" : "false"}>
        {shown.map((x, i) => {
          const secondary = x.label !== null && rank > 0; // the next rank reads as secondary once the talent has a current rank
          return (
            <p key={i} className={`whitespace-pre-line leading-relaxed ${tooltip ? "text-[13px]" : "max-w-[72ch] text-sm"} ${secondary ? "text-parchment/70" : "text-parchment"}`}>
              {x.label && (
                <>
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">{x.label}</span>{" "}
                </>
              )}
              <Segments segments={x.text.segments} />
            </p>
          );
        })}
        {gapCodes.length > 0 &&
          (tooltip ? (
            <p className="text-[11px] text-mist" data-testid="talent-description-gaps">
              <span className="font-mono font-semibold text-gold-300">?</span> not available for this build yet
            </p>
          ) : (
            <div className="text-xs text-mist" data-testid="talent-description-gaps">
              <p>
                <span className="font-mono font-semibold text-gold-300">?</span> marks a value that is not available for this build yet.
              </p>
              <details className="mt-1" data-testid="talent-description-gap-reasons">
                <summary className="cursor-pointer text-violet-300 hover:underline">Why?</summary>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {gapCodes.map((c) => (
                    <li key={c}>{GAP_TEXT[c]}</li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
      </div>
    ) : descriptions ? (
      <div className="space-y-1.5 text-sm leading-relaxed" data-testid="talent-description">
        {rank > 0 && <p>{descriptions[rank - 1]}</p>}
        {rank < talent.maxRank && (
          <p className={rank > 0 ? "text-parchment/70" : undefined}>
            <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-300">{rank > 0 ? "Next rank:" : "Rank 1:"}</span>{" "}
            {descriptions[rank]}
          </p>
        )}
      </div>
    ) : talent.description ? (
      <p className="text-sm leading-relaxed" data-testid="talent-description">{talent.description}</p>
    ) : (
      <p className="text-xs italic text-mist">No description could be verified for this game build, so none is shown.</p>
    );

  const requirements = (points || talentReqs.length > 0) && (
    <ul className="space-y-1 rounded-md bg-ink-950/50 px-2.5 py-1.5 text-xs" aria-label="Requirements">
      {points?.kind === "points" && (
        <li className={`flex gap-1.5 ${points.met ? "text-conf-high" : "text-danger"}`}>
          <span aria-hidden="true" className="w-3 shrink-0 text-center">{points.met ? "✓" : "✕"}</span>
          <span>
            Requires {points.needed} points in {points.treeName} ({Math.min(points.have, points.needed)}/{points.needed}
            {points.assumedScope ? "†" : ""})
          </span>
        </li>
      )}
      {allOf.map((r) => (
        <li key={r.talentId} className={`flex gap-1.5 ${r.met ? "text-conf-high" : "text-danger"}`}>
          <span aria-hidden="true" className="w-3 shrink-0 text-center">{r.met ? "✓" : "✕"}</span>
          <span>
            Requires {r.name} at rank {r.needed} ({Math.min(r.have, r.needed)}/{r.needed})
          </span>
        </li>
      ))}
      {anyOf.length > 0 && (
        <li className={`flex gap-1.5 ${anyOf.some((r) => r.met) ? "text-conf-high" : "text-danger"}`}>
          <span aria-hidden="true" className="w-3 shrink-0 text-center">{anyOf.some((r) => r.met) ? "✓" : "✕"}</span>
          <span>
            Requires {anyOf.length > 1 ? "one of: " : ""}
            {anyOf.map((r) => `${r.name} at rank ${r.needed} (${Math.min(r.have, r.needed)}/${r.needed})`).join(", ")}
          </span>
        </li>
      )}
    </ul>
  );

  const status = (
    <p className="text-xs font-semibold" data-testid="talent-status">
      {maxed ? (
        <span className="text-gold-300">Maximum rank</span>
      ) : add.ok ? (
        <span className="text-conf-high">{tooltip ? "Available - click to add a point" : "Available - click, tap or press Enter to add a point"}</span>
      ) : (
        <span className="text-conf-low">Locked: {REFUSAL_TEXT[add.reason]}</span>
      )}
    </p>
  );

  const assumed = points?.kind === "points" && points.assumedScope && (
    <p className="text-[11px] text-mist">† The game data gives this amount but not where points are counted; it is applied per tree, like every confirmed tier.</p>
  );

  const header = (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
      <div className="order-1 flex min-w-0 flex-1 basis-48 items-start gap-2.5">
        <CardIcon src={icon} />
        <div className="min-w-0">
          <p className="font-[family-name:var(--font-display)] text-base font-semibold leading-tight text-gold-300">{talent.name}</p>
          <p className="mt-0.5 text-xs text-mist">
            {tree.name} · Tier {talent.row + 1}
          </p>
        </div>
      </div>
      {dismiss && <div className="order-2 md:order-4">{dismiss}</div>}
      <div className={`order-3 flex shrink-0 items-center gap-2 rounded-md border px-2 py-1 md:order-2 ${rankTone}`} data-testid="rank-summary">
        <p className="font-mono text-xs font-semibold tabular-nums">
          Rank {rank}/{talent.maxRank}
        </p>
        <span className="contents max-md:hidden">
          <RankPips rank={rank} max={talent.maxRank} />
        </span>
      </div>
      {actions && <div className="order-4 ml-auto md:order-3 md:ml-0">{actions}</div>}
    </div>
  );

  if (tooltip) {
    return (
      <div className="space-y-2.5 text-sm text-parchment">
        {header}
        <div className="border-t border-ink-700 pt-2.5">{description}</div>
        {requirements}
        {assumed}
        {status}
        <p className="font-mono text-[10px] text-mist/70">Spell ID {talent.spellId}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 text-sm text-parchment">
      {header}
      <div className={`${expanded ? "grid" : "hidden"} gap-x-5 gap-y-2.5 border-t border-ink-700 pt-2.5 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]`} data-testid="talent-detail-body">
        <div className="min-w-0">{description}</div>
        <div className="min-w-0 space-y-2">
          {requirements}
          {assumed}
          {status}
          <p className="font-mono text-[10px] text-mist/70">Spell ID {talent.spellId}</p>
        </div>
      </div>
    </div>
  );
}
