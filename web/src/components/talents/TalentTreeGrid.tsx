import type { KeyboardEvent, MouseEvent } from "react";
import type { TalentEngine } from "@/lib/talents/engine";
import type { Allocation, Talent, TalentTree } from "@/lib/talents/types";
import { TalentCard } from "./TalentCard";
import { NodeFace, type NodeState } from "./TalentIcon";

// Grid placement uses these literal class names (Tailwind must see them; the page CSP forbids inline styles).
const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7", 8: "grid-cols-8" };
const COL_START = ["col-start-1", "col-start-2", "col-start-3", "col-start-4", "col-start-5", "col-start-6", "col-start-7", "col-start-8"];
const ROW_START = ["row-start-1", "row-start-2", "row-start-3", "row-start-4", "row-start-5", "row-start-6", "row-start-7", "row-start-8", "row-start-9", "row-start-10", "row-start-11", "row-start-12", "row-start-13", "row-start-14", "row-start-15", "row-start-16"];

export const talentDomId = (id: number) => `talent-${id}`;

// Node frames: one square frame per talent. Border colour, glow and the rank badge change with the state; the icon treatment is in TalentIcon.
const NODE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300 bg-gold-500/20 text-gold-300 shadow-[0_0_0_1px_rgb(0_0_0/0.7),0_0_16px_-2px_rgb(240_223_174/0.6)]",
  partial: "border-violet-300 bg-violet-700/40 text-parchment shadow-[0_0_0_1px_rgb(0_0_0/0.7),0_0_14px_-3px_rgb(195_174_242/0.65)]",
  available: "border-gold-500 bg-ink-800 text-gold-300 shadow-[0_0_0_1px_rgb(0_0_0/0.7)] hover:border-gold-300 hover:shadow-[0_0_0_1px_rgb(0_0_0/0.7),0_0_10px_-3px_rgb(240_223_174/0.5)]",
  waiting: "border-ink-600 bg-ink-850 text-mist shadow-[0_0_0_1px_rgb(0_0_0/0.7)] hover:border-ink-600",
  locked: "border-ink-700 bg-ink-900 text-mist shadow-[0_0_0_1px_rgb(0_0_0/0.7)]",
};
const BADGE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300 bg-gold-400 text-ink-950",
  partial: "border-violet-300 bg-violet-700 text-parchment",
  available: "border-gold-500 bg-ink-950 text-gold-300",
  waiting: "border-ink-600 bg-ink-950 text-mist",
  locked: "border-ink-700 bg-ink-950 text-mist",
};

interface Props {
  tree: TalentTree;
  engine: TalentEngine;
  alloc: Allocation;
  /** The one talent of this tree that is in the tab order (roving tabindex). */
  tabbableId: number;
  /** Selected talent (persistent; shown in the detail panel only). Independent of hover. */
  selectedId: number | null;
  /** Talent under the mouse pointer (temporary; drives the floating tooltip only). Independent of selection. */
  hoverId: number | null;
  /** talent id -> icon URL (empty when icons are not available; nodes then show their name). */
  icons: Readonly<Record<number, string>>;
  onAdd(id: number): void;
  onRemove(id: number): void;
  onFocusTalent(id: number): void;
  onHover(id: number | null): void;
}

export function TalentTreeGrid({ tree, engine, alloc, tabbableId, selectedId, hoverId, icons, onAdd, onRemove, onFocusTalent, onHover }: Props) {
  const byCell = new Map<string, Talent>(tree.talents.map((x) => [`${x.row}:${x.col}`, x]));
  const byId = new Map(tree.talents.map((x) => [x.id, x]));

  // Prerequisite connectors, one line per unordered pair (client data sometimes lists an edge in both directions).
  const seen = new Set<string>();
  const links: Array<{ key: string; from: Talent; to: Talent; active: boolean; focus: boolean }> = [];
  // Lines that touch the selected (or hovered) talent are emphasised so a talent's prerequisites and dependants are easy to follow.
  const focusIds = new Set([selectedId, hoverId].filter((v): v is number => v !== null));
  for (const x of tree.talents) {
    for (const r of x.requires ?? []) {
      const from = byId.get(r.talentId);
      if (!from) continue;
      const key = [from.id, x.id].sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ key, from, to: x, active: engine.rank(alloc, from.id) >= (r.minRank ?? from.maxRank), focus: focusIds.has(from.id) || focusIds.has(x.id) });
    }
  }

  function move(from: Talent, dr: number, dc: number) {
    let r = from.row + dr;
    let c = from.col + dc;
    while (r >= 0 && r < tree.rows && c >= 0 && c < tree.cols) {
      const next = byCell.get(`${r}:${c}`);
      if (next) {
        document.getElementById(talentDomId(next.id))?.focus();
        return;
      }
      r += dr;
      c += dc;
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, x: Talent) {
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); move(x, 0, -1); break;
      case "ArrowRight": e.preventDefault(); move(x, 0, 1); break;
      case "ArrowUp": e.preventDefault(); move(x, -1, 0); break;
      case "ArrowDown": e.preventDefault(); move(x, 1, 0); break;
      case "Backspace":
      case "Delete":
        e.preventDefault();
        onRemove(x.id);
        break;
    }
  }

  // Focusing a talent selects it (keyboard inspection). A mouse press must not focus on mousedown: that would swap the detail
  // panel to its sticky overlay between mousedown and mouseup and could swallow the click. The click handlers select instead
  // and then move focus to the talent, so Backspace and the arrow keys keep working after a click.
  function settle(e: MouseEvent<HTMLButtonElement>) {
    e.currentTarget.focus({ preventScroll: true });
  }

  function onClick(e: MouseEvent<HTMLButtonElement>, x: Talent) {
    if (e.shiftKey) onRemove(x.id);
    else onAdd(x.id);
    settle(e);
  }

  function onContextMenu(e: MouseEvent<HTMLButtonElement>, x: Talent) {
    e.preventDefault();
    onRemove(x.id);
    settle(e);
  }

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${tree.cols} ${tree.rows}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {/* Three strokes per connector: a dark underlay (contrast against the backdrop), an optional glow, and the line itself. A
            met requirement is solid, an unmet one dashed, and a line touching the selected/hovered talent is violet and heavier. */}
        {links.map((l) => {
          const pos = { x1: l.from.col + 0.5, y1: l.from.row + 0.5, x2: l.to.col + 0.5, y2: l.to.row + 0.5 };
          return (
            <g key={l.key} data-link-state={l.active ? "met" : "unmet"} data-link-focus={l.focus || undefined}>
              <line {...pos} strokeLinecap="round" strokeWidth={l.focus ? 9 : 7} className="stroke-ink-950 [vector-effect:non-scaling-stroke]" />
              {l.active && <line {...pos} strokeLinecap="round" strokeWidth={l.focus ? 10 : 8} className={`[vector-effect:non-scaling-stroke] ${l.focus ? "stroke-violet-300/25" : "stroke-gold-400/20"}`} />}
              <line
                {...pos}
                strokeLinecap="round"
                strokeWidth={l.focus ? 4.5 : 3.5}
                className={`[vector-effect:non-scaling-stroke] ${l.active ? (l.focus ? "stroke-violet-300" : "stroke-gold-400") : l.focus ? "stroke-violet-300/80 [stroke-dasharray:2_6]" : "stroke-mist/45 [stroke-dasharray:2_6]"}`}
              />
            </g>
          );
        })}
      </svg>

      <div role="group" aria-label={`${tree.name} talents`} className={`relative grid ${GRID_COLS[tree.cols] ?? "grid-cols-4"}`}>
        {Array.from({ length: tree.rows * tree.cols }, (_, i) => {
          const row = Math.floor(i / tree.cols);
          const col = i % tree.cols;
          const x = byCell.get(`${row}:${col}`);
          const place = `${ROW_START[row] ?? ""} ${COL_START[col] ?? ""}`;
          if (!x) return <div key={`${row}:${col}`} aria-hidden="true" className={`aspect-square ${place}`} />;

          const rank = engine.rank(alloc, x.id);
          const add = engine.canAdd(alloc, x.id);
          const state: NodeState =
            rank >= x.maxRank ? "maxed"
            : rank > 0 ? "partial"
            : add.ok ? "available"
            : !add.ok && add.reason === "no-points" ? "waiting"
            : "locked";
          const locked = !add.ok && rank < x.maxRank;
          const lockNote = !add.ok && add.reason === "no-points" ? "no points remaining" : "requirements not met";
          const aria = `${x.name}, rank ${rank} of ${x.maxRank}${locked ? `, locked: ${lockNote}` : ""}`;
          const tipOpen = hoverId === x.id;
          const hAlign = col < tree.cols / 2 ? "left-0" : "right-0";
          const vAlign = row < tree.rows / 2 ? "top-full mt-1" : "bottom-full mb-1";

          return (
            <div key={x.id} className={`relative flex aspect-square items-center justify-center ${place} ${tipOpen ? "z-30" : "z-10"}`}>
              <button
                type="button"
                id={talentDomId(x.id)}
                aria-label={aria}
                aria-controls="selected-talent-details"
                aria-disabled={locked || undefined}
                tabIndex={x.id === tabbableId ? 0 : -1}
                data-talent-id={x.id}
                data-state={state}
                data-selected={selectedId === x.id || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => onClick(e, x)}
                onContextMenu={(e) => onContextMenu(e, x)}
                onKeyDown={(e) => onKeyDown(e, x)}
                onFocus={() => onFocusTalent(x.id)}
                // Hover is for a mouse (or pen) only: touch has no hover, and its emulated enter would leave a tooltip stuck open.
                onPointerEnter={(e) => { if (e.pointerType !== "touch") onHover(x.id); }}
                onPointerLeave={() => onHover(null)}
                onPointerCancel={() => onHover(null)}
                className={`relative flex aspect-square w-[82%] items-center justify-center rounded-md border-2 text-center text-[10px] font-semibold leading-tight transition-[border-color,box-shadow,background-color] ${NODE_CLASS[state]} ${selectedId === x.id ? "ring-2 ring-parchment ring-offset-2 ring-offset-ink-950" : ""} ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <NodeFace name={x.name} src={icons[x.id]} state={state} />
                <span
                  aria-hidden="true"
                  data-testid="rank-badge"
                  className={`absolute -right-2 -top-2 min-w-[2.15rem] rounded-md border-2 px-1 text-center font-mono text-xs font-bold leading-[18px] tabular-nums shadow-[0_1px_3px_rgb(0_0_0/0.8)] ${BADGE_CLASS[state]}`}
                >
                  {rank}/{x.maxRank}
                </span>
              </button>
              {tipOpen && (
                <div
                  role="tooltip"
                  data-testid="talent-tooltip"
                  className={`pointer-events-none absolute hidden w-80 rounded-lg border border-gold-500/50 bg-ink-900 p-3.5 shadow-2xl ring-1 ring-black/40 md:block ${hAlign} ${vAlign}`}
                >
                  <TalentCard engine={engine} alloc={alloc} talent={x} tree={tree} icon={icons[x.id]} variant="tooltip" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
