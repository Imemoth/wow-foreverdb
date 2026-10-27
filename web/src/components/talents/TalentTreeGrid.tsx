import type { KeyboardEvent, MouseEvent } from "react";
import type { TalentEngine } from "@/lib/talents/engine";
import type { Allocation, Talent, TalentTree } from "@/lib/talents/types";

// Grid placement uses these literal class names (Tailwind must see them; the page CSP forbids inline styles).
const GRID_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4", 5: "grid-cols-5", 6: "grid-cols-6", 7: "grid-cols-7", 8: "grid-cols-8" };
const COL_START = ["col-start-1", "col-start-2", "col-start-3", "col-start-4", "col-start-5", "col-start-6", "col-start-7", "col-start-8"];
const ROW_START = ["row-start-1", "row-start-2", "row-start-3", "row-start-4", "row-start-5", "row-start-6", "row-start-7", "row-start-8", "row-start-9", "row-start-10", "row-start-11", "row-start-12", "row-start-13", "row-start-14", "row-start-15", "row-start-16"];

export const talentDomId = (id: number) => `talent-${id}`;

type NodeState = "maxed" | "partial" | "available" | "waiting" | "locked";

const NODE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300 bg-gold-500/25 text-gold-300 shadow-[0_0_14px_-3px_rgb(240_223_174/0.7)]",
  partial: "border-violet-400 bg-violet-700/45 text-parchment",
  available: "border-gold-400/80 bg-ink-800 text-gold-300 hover:border-gold-300 hover:bg-ink-700",
  waiting: "border-ink-600 bg-ink-800 text-parchment hover:border-ink-600",
  locked: "border-ink-700 bg-ink-900 text-mist",
};
const BADGE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300 text-gold-300",
  partial: "border-violet-300 text-violet-300",
  available: "border-gold-400/80 text-gold-300",
  waiting: "border-ink-600 text-mist",
  locked: "border-ink-700 text-mist",
};

interface Props {
  tree: TalentTree;
  engine: TalentEngine;
  alloc: Allocation;
  /** The one talent of this tree that is in the tab order (roving tabindex). */
  tabbableId: number;
  selectedId: number | null;
  onAdd(id: number): void;
  onRemove(id: number): void;
  onFocusTalent(id: number): void;
}

export function TalentTreeGrid({ tree, engine, alloc, tabbableId, selectedId, onAdd, onRemove, onFocusTalent }: Props) {
  const byCell = new Map<string, Talent>(tree.talents.map((x) => [`${x.row}:${x.col}`, x]));
  const byId = new Map(tree.talents.map((x) => [x.id, x]));

  // Prerequisite connectors, one line per unordered pair (client data sometimes lists an edge in both directions).
  const seen = new Set<string>();
  const links: Array<{ key: string; from: Talent; to: Talent; active: boolean }> = [];
  for (const x of tree.talents) {
    for (const r of x.requires ?? []) {
      const from = byId.get(r.talentId);
      if (!from) continue;
      const key = [from.id, x.id].sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ key, from, to: x, active: engine.rank(alloc, from.id) >= (r.minRank ?? from.maxRank) });
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
        {links.map((l) => (
          <line
            key={l.key}
            x1={l.from.col + 0.5}
            y1={l.from.row + 0.5}
            x2={l.to.col + 0.5}
            y2={l.to.row + 0.5}
            strokeLinecap="round"
            strokeWidth={4}
            className={`[vector-effect:non-scaling-stroke] ${l.active ? "stroke-gold-400" : "stroke-ink-600"}`}
          />
        ))}
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

          return (
            <div key={x.id} className={`relative z-10 flex aspect-square items-center justify-center ${place}`}>
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
                className={`relative flex h-[80%] w-[92%] items-center justify-center rounded-lg border-2 px-0.5 text-center text-[10px] font-semibold leading-tight transition-colors ${NODE_CLASS[state]} ${selectedId === x.id ? "ring-2 ring-violet-300 ring-offset-2 ring-offset-ink-950" : ""} ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span aria-hidden="true" className="line-clamp-3 break-words">{x.name}</span>
                <span
                  aria-hidden="true"
                  className={`absolute -bottom-1.5 -right-1.5 rounded border bg-ink-950 px-1 font-mono text-[11px] leading-4 ${BADGE_CLASS[state]}`}
                >
                  {rank}/{x.maxRank}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
