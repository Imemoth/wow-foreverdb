import { Fragment } from "react";
import { REFUSAL_TEXT, type TalentEngine } from "@/lib/talents/engine";
import { textForRank } from "@/lib/talents/text";
import { GAP_TEXT } from "@/lib/talents/tooltip";
import type { Allocation, Talent, TalentTree, TextSegment } from "@/lib/talents/types";
import { CardIcon } from "./TalentIcon";

/** Description text with every unresolved number shown as an explicit, labelled "?" - never as a guessed value. */
function Segments({ segments }: { segments: TextSegment[] }) {
  return (
    <>
      {segments.map((g, i) =>
        typeof g === "string" ? (
          <Fragment key={i}>{g}</Fragment>
        ) : (
          <span key={i} role="img" aria-label={`value not available: ${GAP_TEXT[g.c]}`} title={GAP_TEXT[g.c]} data-gap={g.c} className="mx-0.5 inline-block rounded border border-dashed border-gold-500/60 px-1 font-mono text-[10px] leading-4 text-gold-300">
            ?
          </span>
        ),
      )}
    </>
  );
}

/**
 * Tooltip/detail body for one talent. Shows only what the data holds: name, rank, tier, the real requirements
 * with their live progress, and - when the dataset carries verified rank text - the current and next rank
 * descriptions. When it does not, it says so rather than inventing text.
 */
export function TalentCard({ engine, alloc, talent, tree, icon, compact = false }: { engine: TalentEngine; alloc: Allocation; talent: Talent; tree: TalentTree; icon?: string; compact?: boolean }) {
  const rank = engine.rank(alloc, talent.id);
  const reqs = engine.requirements(alloc, talent.id);
  const points = reqs.find((r) => r.kind === "points");
  const talentReqs = reqs.filter((r): r is Extract<typeof r, { kind: "talent" }> => r.kind === "talent");
  const allOf = talentReqs.filter((r) => !r.anyOf);
  const anyOf = talentReqs.filter((r) => r.anyOf);
  const add = engine.canAdd(alloc, talent.id);
  const descriptions = talent.descriptions;
  const built = textForRank(talent, rank);
  const gapCodes = built ? [...new Set(built.segments.flatMap((g) => (typeof g === "string" ? [] : [g.c])))] : [];

  return (
    <div className="space-y-2 text-sm text-parchment">
      <div className="flex items-start gap-3">
        <CardIcon src={icon} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="font-[family-name:var(--font-display)] text-base font-semibold text-gold-300">{talent.name}</p>
            <p className="shrink-0 font-mono text-xs text-mist">
              Rank {rank}/{talent.maxRank}
            </p>
          </div>
          <p className="text-xs text-mist">
            {tree.name} · Tier {talent.row + 1}
            {compact ? ` · Spell ID ${talent.spellId}` : ""}
          </p>
        </div>
      </div>

      {(points || talentReqs.length > 0) && (
        <ul className="space-y-0.5 text-xs">
          {points?.kind === "points" && (
            <li className={points.met ? "text-conf-high" : "text-danger"}>
              <span aria-hidden="true">{points.met ? "✓ " : "✗ "}</span>
              Requires {points.needed} points in {points.treeName} ({Math.min(points.have, points.needed)}/{points.needed}
              {points.assumedScope ? "†" : ""})
            </li>
          )}
          {allOf.map((r) => (
            <li key={r.talentId} className={r.met ? "text-conf-high" : "text-danger"}>
              <span aria-hidden="true">{r.met ? "✓ " : "✗ "}</span>
              Requires {r.name} at rank {r.needed} ({Math.min(r.have, r.needed)}/{r.needed})
            </li>
          ))}
          {anyOf.length > 0 && (
            <li className={anyOf.some((r) => r.met) ? "text-conf-high" : "text-danger"}>
              <span aria-hidden="true">{anyOf.some((r) => r.met) ? "✓ " : "✗ "}</span>
              Requires {anyOf.length > 1 ? "one of: " : ""}
              {anyOf.map((r) => `${r.name} at rank ${r.needed} (${Math.min(r.have, r.needed)}/${r.needed})`).join(", ")}
            </li>
          )}
        </ul>
      )}

      {built ? (
        <div className="space-y-1.5 border-t border-ink-700 pt-2 text-xs" data-testid="talent-description" data-complete={built.complete ? "true" : "false"}>
          <p className="whitespace-pre-line">
            <Segments segments={built.segments} />
          </p>
          {gapCodes.length > 0 && (
            <p className="text-[11px] text-mist" data-testid="talent-description-gaps">
              <span className="font-mono text-gold-300">?</span> marks a number that is not available for this game build yet
              {compact ? "." : `: ${gapCodes.map((c) => GAP_TEXT[c]).join(" ")}`}
            </p>
          )}
        </div>
      ) : descriptions ? (
        <div className="space-y-1.5 border-t border-ink-700 pt-2 text-xs" data-testid="talent-description">
          {rank > 0 && <p>{descriptions[rank - 1]}</p>}
          {rank < talent.maxRank && (
            <p className={rank > 0 ? "text-mist" : undefined}>
              <span className="font-semibold">{rank > 0 ? "Next rank:" : "Rank 1:"}</span> {descriptions[rank]}
            </p>
          )}
        </div>
      ) : talent.description ? (
        <p className="border-t border-ink-700 pt-2 text-xs" data-testid="talent-description">{talent.description}</p>
      ) : (
        <p className="border-t border-ink-700 pt-2 text-xs italic text-mist">
          No description could be verified for this game build, so none is shown.
        </p>
      )}

      {points?.kind === "points" && points.assumedScope && (
        <p className="text-[11px] text-mist">† The game data gives this amount but not where points are counted; it is applied per tree, like every confirmed tier.</p>
      )}

      {!compact && (
        <p className="text-xs">
          {rank >= talent.maxRank ? (
            <span className="text-gold-300">Maximum rank.</span>
          ) : add.ok ? (
            <span className="text-conf-high">Available - click, tap or press Enter to add a point.</span>
          ) : (
            <span className="text-conf-low">Locked: {REFUSAL_TEXT[add.reason]}</span>
          )}
        </p>
      )}
      {!compact && <p className="font-mono text-[11px] text-mist">Spell ID {talent.spellId}</p>}
    </div>
  );
}
