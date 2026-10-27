"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BUILD_PARAM, DECODE_FAILURE_TEXT, decodeBuild, encodeBuild } from "@/lib/talents/build-code";
import { createEngine, REFUSAL_TEXT } from "@/lib/talents/engine";
import type { Allocation, TalentClassData } from "@/lib/talents/types";
import { TalentCard } from "./TalentCard";
import { TalentTreeGrid } from "./TalentTreeGrid";

interface Props {
  data: TalentClassData;
  /** Short provenance line shown under the calculator (source, build, what is not verified). */
  sourceNote: string;
  /** Tree to emphasise, e.g. on a specialization page. */
  highlightTreeId?: number;
}

export function TalentCalculator({ data, sourceNote, highlightTreeId }: Props) {
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [shareText, setShareText] = useState<string | null>(null);
  const [tabbable, setTabbable] = useState<Record<number, number>>({});
  const shareInput = useRef<HTMLInputElement>(null);

  // Keep the address bar equal to the current build so the page URL is always the share link.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (engine.spent(alloc) > 0) url.searchParams.set(BUILD_PARAM, encodeBuild(data, alloc));
    else url.searchParams.delete(BUILD_PARAM);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [alloc, engine, data]);

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

  function reset() {
    setSelectedId(null);
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
      onKeyDown={(e) => {
        if (e.key === "Escape" && selectedId !== null) {
          e.preventDefault();
          setSelectedId(null);
        }
      }}
    >
      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
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
        <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={share} className="btn-ghost" data-testid="share-build">Share build</button>
          <button type="button" onClick={reset} disabled={spent === 0} className="btn-ghost disabled:cursor-not-allowed disabled:opacity-50" data-testid="reset-build">Reset build</button>
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

      <p className="text-xs text-mist">
        <span className="font-semibold text-parchment">Controls:</span> click, tap or press Enter to add a point · right-click, Shift+click, Backspace or the Remove button to take one back · arrow keys move between talents. Select or focus a talent for details below; Escape clears the selection.
      </p>

      <div className="grid gap-6 lg:grid-cols-3">
        {data.trees.map((tree) => {
          const pts = engine.pointsInTree(alloc, tree.id);
          const tabbableId = tabbable[tree.id] ?? tree.talents[0]!.id;
          return (
            <section
              key={tree.id}
              aria-labelledby={`tree-${tree.id}`}
              className={`panel p-3 sm:p-4 ${highlightTreeId === tree.id ? "ring-1 ring-gold-400/60" : ""}`}
              data-testid={`tree-${tree.slug}`}
            >
              <h3 id={`tree-${tree.id}`} className="mb-3 flex items-baseline justify-between font-[family-name:var(--font-display)] text-lg text-gold-300">
                <span>{tree.name}</span>
                <span className="font-mono text-sm text-parchment" aria-label={`${pts} points spent in ${tree.name}`}>{pts}</span>
              </h3>
              <TalentTreeGrid
                tree={tree}
                engine={engine}
                alloc={alloc}
                tabbableId={tabbableId}
                selectedId={selectedId}
                onAdd={add}
                onRemove={remove}
                onFocusTalent={(id) => { setSelectedId(id); setTabbable((t) => ({ ...t, [tree.id]: id })); }}
              />
            </section>
          );
        })}
      </div>

      <div id="selected-talent-details" role="region" aria-label="Selected talent details" className={selected ? "sticky bottom-3 z-20" : ""} data-testid="talent-detail">
        <div className="panel max-h-[40vh] overflow-y-auto border-gold-500/40 p-3 shadow-2xl sm:p-4">
          {selected && selectedTree ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <TalentCard engine={engine} alloc={alloc} talent={selected} tree={selectedTree} compact />
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn-ghost min-h-11 min-w-11 disabled:cursor-not-allowed disabled:opacity-50" onClick={() => remove(selected.id)} disabled={!engine.canRemove(alloc, selected.id).ok} aria-label={`Remove a point from ${selected.name}`}>
                  − Remove
                </button>
                <button type="button" className="btn-primary min-h-11 min-w-11 disabled:cursor-not-allowed" onClick={() => add(selected.id)} disabled={!engine.canAdd(alloc, selected.id).ok} aria-label={`Add a point to ${selected.name}`}>
                  + Add
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-mist">Select a talent to see its details, requirements and add or remove points.</p>
          )}
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only" data-testid="announcer">{announce}</p>
      <p className="text-xs text-mist">{sourceNote}</p>
    </section>
  );
}
