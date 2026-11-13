"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPreviewAdapter, type AdminPort } from "../adapter";
import type { PreviewAction } from "../domain/engine";
import type { Outcome, PreviewState } from "../domain/types";

export interface Toast { id: number; tone: "success" | "error" | "warning" | "info"; text: string }

interface AdminContextValue {
  state: PreviewState;
  ready: boolean;
  /** Runs an action, shows feedback, and offers the TOTP step-up dialog (then retries) when freshness expired. */
  run: (action: PreviewAction, opts?: { quiet?: boolean }) => Outcome;
  dryRun: (action: PreviewAction) => Outcome;
  reset: () => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  stepUp: { open: boolean; retry: PreviewAction | null };
  closeStepUp: () => void;
  openStepUp: () => void;
  /** True for every page heading after the first: the first view of a page load must not steal focus from the skip link. */
  shouldFocusHeading: () => boolean;
  controlsOpen: boolean;
  setControlsOpen: (v: boolean) => void;
}

const Ctx = createContext<AdminContextValue | null>(null);

export function useAdmin(): AdminContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAdmin must be used inside <AdminProvider>");
  return v;
}

export function AdminProvider({ children, adapter: injected }: { children: ReactNode; adapter?: AdminPort }) {
  const [adapter] = useState<AdminPort>(() => injected ?? createPreviewAdapter());
  const state = useSyncExternalStore(adapter.subscribe, adapter.getSnapshot, adapter.getSnapshot);
  const ready = useSyncExternalStore(adapter.subscribe, adapter.isReady, () => false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [stepUp, setStepUp] = useState<{ open: boolean; retry: PreviewAction | null }>({ open: false, retry: null });
  const [controlsOpen, setControlsOpen] = useState(false);
  const toastId = useRef(0);
  const firstHeading = useRef(true);

  // Restoring the tab session happens after mount so the server-rendered and first client render match (both "loading").
  useEffect(() => {
    adapter.hydrate();
  }, [adapter]);

  const pushToast = useCallback((tone: Toast["tone"], text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 9000 : 5000);
  }, []);

  const shouldFocusHeading = useCallback((): boolean => { const first = firstHeading.current; firstHeading.current = false; return !first; }, []);

  const run = useCallback((action: PreviewAction, opts?: { quiet?: boolean }): Outcome => {
    const o = adapter.dispatch(action);
    if (!opts?.quiet) {
      if (o.ok) pushToast("success", o.message);
      else if (o.kind === "noop") pushToast("info", o.message);
      else if (o.kind === "invalid") pushToast("warning", o.message);
      else pushToast("error", o.message);
    }
    if (!o.ok && o.code === "step_up_required") setStepUp({ open: true, retry: action });
    return o;
  }, [adapter, pushToast]);

  const value = useMemo<AdminContextValue>(() => ({
    state, ready, run, dryRun: (a) => adapter.dryRun(a), reset: () => { adapter.reset(); pushToast("info", "Preview data reset to the synthetic seed."); },
    toasts, dismissToast: (id) => setToasts((t) => t.filter((x) => x.id !== id)),
    stepUp, closeStepUp: () => setStepUp({ open: false, retry: null }), openStepUp: () => setStepUp({ open: true, retry: null }),
    shouldFocusHeading, controlsOpen, setControlsOpen,
  }), [state, ready, run, adapter, toasts, stepUp, controlsOpen, pushToast, shouldFocusHeading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
