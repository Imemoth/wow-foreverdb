import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { TalentEngine } from "@/lib/talents/engine";
import type { Allocation, Talent, TalentTree } from "@/lib/talents/types";
import { TalentCard } from "./TalentCard";
import { NodeFace, type NodeState } from "./TalentIcon";

// Grid placement uses these literal class names (Tailwind must see them; the page CSP forbids inline styles). One cell is
// `--cell` square (a CSS variable set on the tree, see below): the node button fills the whole cell, so its hit area is the
// cell, while the visible frame is a little smaller and centred in it. Connectors are drawn in cell units, so they always end
// at the frame centres whatever the cell size.
const GRID_COLS: Record<number, string> = {
  1: "grid-cols-[repeat(1,var(--cell))]", 2: "grid-cols-[repeat(2,var(--cell))]", 3: "grid-cols-[repeat(3,var(--cell))]", 4: "grid-cols-[repeat(4,var(--cell))]",
  5: "grid-cols-[repeat(5,var(--cell))]", 6: "grid-cols-[repeat(6,var(--cell))]", 7: "grid-cols-[repeat(7,var(--cell))]", 8: "grid-cols-[repeat(8,var(--cell))]",
};
const COL_START = ["col-start-1", "col-start-2", "col-start-3", "col-start-4", "col-start-5", "col-start-6", "col-start-7", "col-start-8"];
const ROW_START = ["row-start-1", "row-start-2", "row-start-3", "row-start-4", "row-start-5", "row-start-6", "row-start-7", "row-start-8", "row-start-9", "row-start-10", "row-start-11", "row-start-12", "row-start-13", "row-start-14", "row-start-15", "row-start-16"];
// 60px cells (42px frames, a ≥44px hit area, 9px of air around each frame) on small screens, 68px cells (46px frames) from `sm` up.
const CELL_VARS = "[--cell:3.75rem] sm:[--cell:4.25rem]";

export const talentDomId = (id: number) => `talent-${id}`;

// Node frames: one square frame per talent, thin border, quiet glow. The state is in border colour, glow, icon treatment, the rank
// badge and (locked) the lock glyph; selection is a separate ring (group-data-[selected]) so it never reads as an allocation state.
const NODE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300/80 bg-gold-500/15 text-gold-300 shadow-[0_0_0_1px_rgb(0_0_0/0.6),0_0_8px_-2px_rgb(240_223_174/0.4)]",
  partial: "border-violet-300/70 bg-violet-700/30 text-parchment shadow-[0_0_0_1px_rgb(0_0_0/0.6),0_0_8px_-2px_rgb(195_174_242/0.4)]",
  available: "border-gold-500/70 bg-ink-800 text-gold-300 shadow-[0_0_0_1px_rgb(0_0_0/0.6)] group-hover:border-gold-300",
  waiting: "border-ink-600 bg-ink-850 text-mist shadow-[0_0_0_1px_rgb(0_0_0/0.5)]",
  locked: "border-ink-700/80 bg-ink-900 text-mist/80 shadow-[0_0_0_1px_rgb(0_0_0/0.4)]",
};
const BADGE_CLASS: Record<NodeState, string> = {
  maxed: "border-gold-300/70 bg-gold-500 text-ink-950",
  partial: "border-violet-300/60 bg-violet-700 text-parchment",
  available: "border-gold-500/60 bg-ink-950 text-gold-300",
  waiting: "border-ink-700 bg-ink-950/90 text-mist/80",
  locked: "border-ink-800 bg-ink-950/80 text-mist/60",
};

/**
 * Hover tooltip, anchored beside its node. After layout it is nudged back inside the viewport (CSSOM, not an inline style
 * attribute, so the page CSP is not involved), so a node near either edge never gets a clipped tooltip.
 */
function Tooltip({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const margin = 8;
    const dx = Math.max(0, margin - r.left) + Math.min(0, window.innerWidth - margin - r.right);
    const dy = Math.max(0, margin - r.top) + Math.min(0, window.innerHeight - margin - r.bottom);
    if (dx || dy) el.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  return (
    <div ref={ref} role="tooltip" data-testid="talent-tooltip" className={className}>
      {children}
    </div>
  );
}

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
    <div className={`relative mx-auto w-fit ${CELL_VARS}`} data-testid="talent-grid" data-cols={tree.cols} data-rows={tree.rows}>
      <svg
        viewBox={`0 0 ${tree.cols} ${tree.rows}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {/* Three strokes per connector: a dark underlay (contrast against the backdrop), an optional glow, and the line itself. A
            met requirement is a thin solid gold line, an unmet one a faint dotted line, and a line touching the selected/hovered
            talent is violet and heavier so a talent's chain is easy to follow. */}
        {links.map((l) => {
          const pos = { x1: l.from.col + 0.5, y1: l.from.row + 0.5, x2: l.to.col + 0.5, y2: l.to.row + 0.5 };
          return (
            <g key={l.key} data-link-state={l.active ? "met" : "unmet"} data-link-focus={l.focus || undefined}>
              <line {...pos} strokeLinecap="round" strokeWidth={l.focus ? 6 : l.active ? 4.5 : 3} className="stroke-ink-950/80 [vector-effect:non-scaling-stroke]" />
              {l.active && <line {...pos} strokeLinecap="round" strokeWidth={l.focus ? 8 : 6} className={`[vector-effect:non-scaling-stroke] ${l.focus ? "stroke-violet-300/20" : "stroke-gold-400/10"}`} />}
              <line
                {...pos}
                strokeLinecap="round"
                strokeWidth={l.focus ? 3 : l.active ? 2 : 1.5}
                className={`[vector-effect:non-scaling-stroke] ${l.active ? (l.focus ? "stroke-violet-300" : "stroke-gold-400/80") : l.focus ? "stroke-violet-300/70 [stroke-dasharray:1.5_5]" : "stroke-mist/30 [stroke-dasharray:1.5_5]"}`}
              />
            </g>
          );
        })}
      </svg>

      <div role="group" aria-label={`${tree.name} talents`} className={`relative grid auto-rows-[var(--cell)] ${GRID_COLS[tree.cols] ?? "grid-cols-[repeat(4,var(--cell))]"}`}>
        {Array.from({ length: tree.rows * tree.cols }, (_, i) => {
          const row = Math.floor(i / tree.cols);
          const col = i % tree.cols;
          const x = byCell.get(`${row}:${col}`);
          const place = `${ROW_START[row] ?? ""} ${COL_START[col] ?? ""}`;
          if (!x) return <div key={`${row}:${col}`} aria-hidden="true" className={place} />;

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
            <div key={x.id} className={`relative ${place} ${tipOpen ? "z-30" : "z-10"}`}>
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
                // The button is the whole cell (the hit area); the visible frame inside it is smaller. The focus ring is drawn on the frame.
                className={`group relative flex h-full w-full touch-manipulation scroll-mb-44 items-center justify-center focus-visible:outline-none ${locked ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <span
                  data-testid="node-frame"
                  className={`pointer-events-none relative size-[2.625rem] rounded-[5px] border text-center font-semibold transition-[border-color,box-shadow] sm:size-[2.875rem] ${NODE_CLASS[state]} group-data-[selected]:ring-2 group-data-[selected]:ring-parchment group-data-[selected]:ring-offset-1 group-data-[selected]:ring-offset-ink-950 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-violet-400`}
                >
                  <NodeFace name={x.name} src={icons[x.id]} state={state} />
                  <span
                    aria-hidden="true"
                    data-testid="rank-badge"
                    className={`absolute -bottom-[3px] -right-[3px] min-w-[1.375rem] rounded-[4px] border px-[2px] text-center font-mono text-[10px] font-semibold leading-[12px] tabular-nums shadow-[0_1px_2px_rgb(0_0_0/0.7)] ${BADGE_CLASS[state]}`}
                  >
                    {rank}/{x.maxRank}
                  </span>
                </span>
              </button>
              {tipOpen && (
                <Tooltip className={`pointer-events-none absolute hidden w-72 rounded-lg border border-gold-500/50 bg-ink-900 p-3 shadow-2xl ring-1 ring-black/40 wide:block ${hAlign} ${vAlign}`}>
                  <TalentCard engine={engine} alloc={alloc} talent={x} tree={tree} icon={icons[x.id]} variant="tooltip" />
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
