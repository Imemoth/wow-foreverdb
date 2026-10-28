"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILD_PARAM, DECODE_FAILURE_TEXT, decodeBuild, encodeBuild } from "@/lib/talents/build-code";
import { createEngine, REFUSAL_TEXT } from "@/lib/talents/engine";
import type { Allocation, TalentClassData } from "@/lib/talents/types";
import { TreeBackdrop } from "@/components/classes/backdrops";
import { TalentCard } from "./TalentCard";
import { TalentTreeGrid, talentDomId } from "./TalentTreeGrid";

interface Props {
  data: TalentClassData;
  /** Tree to emphasise, e.g. on a specialization page. */
  highlightTreeId?: number;
  /** talent id -> icon URL. Empty/absent: nodes show their name (no icons are available for this build or deployment). */
  icons?: Readonly<Record<number, string>>;
}

const NO_ICONS: Readonly<Record<number, string>> = {};

// Legend for the node states (same borders as the nodes; the state is also in each node's accessible name and in the detail panel).
const LEGEND: ReadonlyArray<{ label: string; swatch: string }> = [
  { label: "Available", swatch: "border-gold-500/70 bg-ink-800" },
  { label: "In progress", swatch: "border-violet-300/70 bg-violet-700/50" },
  { label: "Maxed", swatch: "border-gold-300/80 bg-gold-500/40" },
  { label: "Locked", swatch: "border-ink-700 bg-ink-900" },
  { label: "Selected", swatch: "border-ink-700 bg-ink-900 ring-1 ring-parchment ring-offset-1 ring-offset-ink-950" },
];

export function TalentCalculator({ data, highlightTreeId, icons = NO_ICONS }: Props) {
  const engine = useMemo(() => createEngine(data), [data]);
  // A shared build in ?b= is decoded once, while rendering (on the server too, so a shared link renders with its build and
  // never flashes an empty one). An invalid link falls back to an empty build with an explanation.
  const params = useSearchParams();
  const [initial] = useState(() => {
    const code = params.get(BUILD_PARAM);
    if (!code) return { alloc: {} as Allocation, error: null as string | null };
    const r = decodeBuild(engine, code);
    return r.ok ? { alloc: r.allocation, error: null as string | null } : { alloc: {} as Allocation, error: DECODE_FAILURE_TEXT[r.reason] };
  });
  const [alloc, setAlloc] = useState<Allocation>(initial.alloc);
  const [linkError, setLinkError] = useState<string | null>(initial.error);
  // Two independent states: `selectedId` is persistent and shown only in the detail panel; `hoverId` is the talent under the
  // mouse and drives only the floating tooltip. Neither is derived from the other.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [shareText, setShareText] = useState<string | null>(null);
  const [tabbable, setTabbable] = useState<Record<number, number>>({});
  // Mobile bottom sheet: collapsed (name, rank, Add/Remove) or expanded (full details). Wide screens always show the details.
  const [sheetOpen, setSheetOpen] = useState(false);
  const shareInput = useRef<HTMLInputElement>(null);
  // Closing the panel hands focus back to the talent without re-selecting it (focusing a talent normally selects it).
  const skipFocusSelect = useRef(false);

  // Keep the address bar equal to the current build so the page URL is always the share link.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (engine.spent(alloc) > 0) url.searchParams.set(BUILD_PARAM, encodeBuild(data, alloc));
    else url.searchParams.delete(BUILD_PARAM);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [alloc, engine, data]);

  // Escape clears the selection and any open tooltip, wherever keyboard focus is (a hover-only tooltip has no focus to hang a handler on).
  const hasTransient = selectedId !== null || hoverId !== null;
  useEffect(() => {
    if (!hasTransient) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setSelectedId(null);
      setHoverId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hasTransient]);

  const spent = engine.spent(alloc);
  const remaining = engine.remaining(alloc);
  const { total, firstPointLevel } = data.pointBudget;
  const requiredLevel = spent > 0 ? firstPointLevel + spent - 1 : null;

  const add = useCallback((id: number) => {
    setSelectedId(id);
    const verdict = engine.canAdd(alloc, id);
    const talent = engine.talent(id);
    if (!verdict.ok) {
      setAnnounce(`${talent?.name ?? "Talent"}: ${REFUSAL_TEXT[verdict.reason]}`);
      return;
    }
    const next = engine.add(alloc, id);
    setAlloc(next);
    setLinkError(null);
    setAnnounce(`${talent?.name}: rank ${engine.rank(next, id)} of ${talent?.maxRank}. ${engine.remaining(next)} points remaining.`);
  }, [alloc, engine]);

  const remove = useCallback((id: number) => {
    setSelectedId(id);
    const verdict = engine.canRemove(alloc, id);
    const talent = engine.talent(id);
    if (!verdict.ok) {
      setAnnounce(`${talent?.name ?? "Talent"}: ${REFUSAL_TEXT[verdict.reason]}`);
      return;
    }
    const next = engine.remove(alloc, id);
    setAlloc(next);
    setLinkError(null);
    setAnnounce(`${talent?.name}: rank ${engine.rank(next, id)} of ${talent?.maxRank}. ${engine.remaining(next)} points remaining.`);
  }, [alloc, engine]);

  function closePanel() {
    const id = selectedId;
    skipFocusSelect.current = true;
    setSelectedId(null);
    setHoverId(null);
    if (id !== null) document.getElementById(talentDomId(id))?.focus({ preventScroll: true });
    // Focus may already have been on that talent (no focus event then): do not leave the flag armed.
    queueMicrotask(() => { skipFocusSelect.current = false; });
  }

  function reset() {
    setSelectedId(null);
    setHoverId(null);
    setAlloc(engine.reset());
    setLinkError(null);
    setShareText(null);
    setAnnounce("Build reset. All talent points are available again.");
  }

  async function share() {
    const link = new URL(window.location.href);
    if (spent > 0) link.searchParams.set(BUILD_PARAM, encodeBuild(data, alloc));
    const text = link.toString();
    setShareText(text);
    try {
      await navigator.clipboard.writeText(text);
      setAnnounce("Build link copied to the clipboard.");
    } catch {
      setAnnounce("Copy was not possible here. The build link is shown below to copy by hand.");
      queueMicrotask(() => shareInput.current?.select());
    }
  }

  const selected = selectedId !== null ? engine.talent(selectedId) : undefined;
  const selectedTree = selected ? engine.treeOf(selected.id) : undefined;

  return (
    <section
      aria-labelledby="calc-title"
      className="space-y-4"
      data-testid="talent-calculator"
    >
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-2.5 p-3 sm:p-4">
        <div className="min-w-0">
          <h2 id="calc-title" className="panel-title text-xl">{data.className} talent calculator</h2>
          <p className="text-xs text-mist">
            Build {data.build.version} · {total} talent points, one per level from level {firstPointLevel}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm" aria-label="Talent points">
          <div>
            <dt className="text-xs uppercase tracking-wide text-mist">Spent</dt>
            <dd className="font-mono text-lg text-gold-300" data-testid="points-spent">{spent}<span className="text-mist">/{total}</span></dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-mist">Remaining</dt>
            <dd className="font-mono text-lg text-parchment" data-testid="points-remaining">{remaining}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-mist">Required level</dt>
            <dd className="font-mono text-lg text-parchment" data-testid="required-level">{requiredLevel ?? "-"}</dd>
          </div>
        </dl>
        <div className="flex gap-2 max-sm:w-full sm:ml-auto">
          <button type="button" onClick={share} className="btn-ghost min-h-11 max-sm:flex-1 sm:min-h-10" data-testid="share-build">Share build</button>
          <button type="button" onClick={reset} disabled={spent === 0} className="btn-ghost min-h-11 disabled:cursor-not-allowed disabled:opacity-50 max-sm:flex-1 sm:min-h-10" data-testid="reset-build">Reset build</button>
        </div>
        {shareText && (
          <div className="flex w-full items-center gap-2">
            <label htmlFor="share-link" className="sr-only">Build link</label>
            <input ref={shareInput} id="share-link" readOnly value={shareText} onFocus={(e) => e.currentTarget.select()} className="field w-full font-mono text-xs" />
          </div>
        )}
      </div>

      {linkError && (
        <p role="alert" className="rounded-lg border border-conf-low/50 bg-ink-900 px-4 py-3 text-sm text-conf-low" data-testid="link-error">
          {linkError} Starting with an empty build.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-mist" data-testid="talent-legend">
        <ul aria-label="Talent states" className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          {LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-3 rounded-[3px] border ${l.swatch}`} />
              {l.label}
            </li>
          ))}
        </ul>
        <p className="text-xs" data-testid="talent-hint">
          <span className="sm:hidden">Tap a talent to add a point.</span>
          <span className="max-sm:hidden">Click to add a point, right-click to remove.</span>
        </p>
        <details className="group relative ml-auto" data-testid="talent-help">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md px-2 text-xs font-semibold text-violet-300 hover:text-violet-300/80 sm:min-h-8 [&::-webkit-details-marker]:hidden">
            How to use
            <span aria-hidden="true" className="text-[10px] transition-transform group-open:rotate-180">▾</span>
          </summary>
          <div className="panel absolute right-0 top-full z-40 mt-1 w-[min(26rem,calc(100vw-2rem))] border-gold-500/40 bg-ink-900 bg-none p-3 text-xs text-parchment shadow-2xl">
            <ul className="list-disc space-y-1 pl-4 marker:text-mist">
              <li><span className="text-mist">Add a point:</span> click, tap, or press Enter on a talent.</li>
              <li><span className="text-mist">Remove a point:</span> right-click, Shift+click, or Backspace / Delete.</li>
              <li><span className="text-mist">Move between talents:</span> the arrow keys.</li>
              <li><span className="text-mist">Quick look:</span> hover a talent (mouse). <span className="text-mist">Details:</span> select it, then use the panel below.</li>
              <li><span className="text-mist">Close the panel:</span> its × button, or Escape.</li>
              <li><span className="text-mist">Share:</span> Share build copies a link to this exact build.</li>
            </ul>
          </div>
        </details>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {data.trees.map((tree) => {
          const pts = engine.pointsInTree(alloc, tree.id);
          const tabbableId = tabbable[tree.id] ?? tree.talents[0]!.id;
          return (
            <section
              key={tree.id}
              aria-labelledby={`tree-${tree.id}`}
              className={`panel relative p-3 ${highlightTreeId === tree.id ? "ring-1 ring-gold-400/60" : ""}`}
              data-testid={`tree-${tree.slug}`}
            >
              {/* Decorative, non-interactive. It clips itself, so the panel does not (tooltips may overflow it) and no stacking context is created. */}
              <TreeBackdrop classId={data.classId} treeSlug={tree.slug} />
              <div className="relative">
                <h3 id={`tree-${tree.id}`} className="mb-2 flex items-baseline justify-between font-[family-name:var(--font-display)] text-lg text-gold-300">
                  <span>{tree.name}</span>
                  <span className="font-mono text-sm text-parchment" aria-label={`${pts} points spent in ${tree.name}`}>{pts}</span>
                </h3>
                <TalentTreeGrid
                  tree={tree}
                  engine={engine}
                  alloc={alloc}
                  tabbableId={tabbableId}
                  selectedId={selectedId}
                  hoverId={hoverId}
                  icons={icons}
                  onAdd={add}
                  onRemove={remove}
                  onFocusTalent={(id) => { if (skipFocusSelect.current) skipFocusSelect.current = false; else setSelectedId(id); setTabbable((t) => ({ ...t, [tree.id]: id })); }}
                  onHover={setHoverId}
                />
              </div>
            </section>
          );
        })}
      </div>

      {/* The detail panel: a compact, dismissible card under the trees that sticks to the bottom of the screen while a talent is
          selected (a bottom sheet on phones: collapsed to name, rank and Add/Remove, expandable to the full details). The wrapper
          lets pointer events through, so only the card itself ever takes a click and it never gets in the way of the talents. */}
      <div
        id="selected-talent-details"
        role="region"
        aria-label="Selected talent details"
        className={selected ? "pointer-events-none sticky bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-20" : ""}
        data-testid="talent-detail"
      >
        {selected && selectedTree ? (
          <div
            className={`panel pointer-events-auto overflow-y-auto border-gold-500/40 bg-ink-900 bg-none p-3 shadow-2xl md:max-h-[40vh] ${sheetOpen ? "max-h-[62vh]" : ""}`}
            data-testid="talent-detail-card"
            data-sheet={sheetOpen ? "expanded" : "collapsed"}
          >
            <TalentCard
              engine={engine}
              alloc={alloc}
              talent={selected}
              tree={selectedTree}
              icon={icons[selected.id]}
              expanded={sheetOpen}
              actions={
                <div className="flex items-center gap-1.5" data-testid="panel-controls">
                  <button type="button" className="btn-ghost min-h-11 min-w-11 px-3 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9 md:min-w-0" onClick={() => remove(selected.id)} disabled={!engine.canRemove(alloc, selected.id).ok} aria-label={`Remove a point from ${selected.name}`}>
                    − Remove
                  </button>
                  <button type="button" className="btn-primary min-h-11 min-w-11 px-3 disabled:cursor-not-allowed md:min-h-9 md:min-w-0" onClick={() => add(selected.id)} disabled={!engine.canAdd(alloc, selected.id).ok} aria-label={`Add a point to ${selected.name}`}>
                    + Add
                  </button>
                </div>
              }
              dismiss={
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-ink-600 text-mist hover:border-gold-500/60 hover:text-parchment md:hidden"
                    aria-expanded={sheetOpen}
                    aria-label={sheetOpen ? "Hide talent details" : "Show talent details"}
                    data-testid="panel-toggle"
                    onClick={() => setSheetOpen((v) => !v)}
                  >
                    <span aria-hidden="true" className={`text-xs transition-transform ${sheetOpen ? "" : "rotate-180"}`}>▾</span>
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-ink-600 text-lg leading-none text-mist hover:border-gold-500/60 hover:text-parchment md:min-h-9 md:min-w-9"
                    aria-label="Close talent details"
                    data-testid="panel-close"
                    onClick={closePanel}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </div>
              }
            />
          </div>
        ) : (
          <p className="px-1 text-xs text-mist" data-testid="talent-detail-empty">Select a talent to see its details and requirements.</p>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-testid="announcer">{announce}</p>
    </section>
  );
}
