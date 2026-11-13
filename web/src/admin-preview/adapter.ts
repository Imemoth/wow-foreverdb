import { PREVIEW_BUNDLE_MARKER } from "./domain/marker";
import { apply, initialState, type PreviewAction } from "./domain/engine";
import type { Outcome, PreviewState } from "./domain/types";

/**
 * The ONLY surface the preview UI uses to read and change Admin data. A future production implementation would talk to the real
 * protected Admin services behind this same shape; the preview implementation below is a synthetic, in-memory simulation.
 *
 * Boundary rules (enforced by review and by tests/unit/admin-preview-isolation.test.ts):
 *  - the UI never imports the engine, seed or storage directly — only an AdminPort;
 *  - this adapter performs no network I/O, reads no environment variable and holds no credential;
 *  - `kind` is a literal so production wiring can never silently be handed the synthetic adapter.
 */
export interface AdminPort {
  readonly kind: "synthetic-preview";
  readonly marker: string;
  getSnapshot(): PreviewState;
  subscribe(listener: () => void): () => void;
  dispatch(action: PreviewAction): Outcome;
  /** Pure what-if: the outcome the action WOULD produce, with no state change and no audit event. */
  dryRun(action: PreviewAction): Outcome;
  reset(): void;
  /** Restore a previous tab session from sessionStorage, if any. Returns true when something was restored. */
  hydrate(): boolean;
  /** False until hydrate() has run once (server render and first client render), so SSR and hydration agree. */
  isReady(): boolean;
}

const STORAGE_KEY = "azerdex-admin-preview/v1";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): Store | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // blocked storage: the preview still works, it just does not survive a reload
  }
}

function plausible(v: unknown): v is PreviewState {
  if (!v || typeof v !== "object") return false;
  const o = v as Partial<PreviewState>;
  return o.version === 1 && typeof o.now === "number" && Array.isArray(o.articles) && Array.isArray(o.revisions) && Array.isArray(o.staff) && Array.isArray(o.audit) && !!o.session;
}

export function createPreviewAdapter(storage: Store | null | undefined = undefined): AdminPort {
  const store = storage === undefined ? browserStorage() : storage;
  let state = initialState();
  let ready = false;
  const listeners = new Set<() => void>();
  const emit = (): void => listeners.forEach((l) => l());
  const persist = (): void => {
    try { store?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota or blocked: ignore */ }
  };
  return {
    kind: "synthetic-preview",
    marker: PREVIEW_BUNDLE_MARKER,
    getSnapshot: () => state,
    subscribe(l) { listeners.add(l); return () => { listeners.delete(l); }; },
    dispatch(action) {
      const r = apply(state, action);
      state = r.state;
      persist();
      emit();
      return r.outcome;
    },
    dryRun: (action) => apply(state, action).outcome,
    reset() {
      state = initialState();
      try { store?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      emit();
    },
    isReady: () => ready,
    hydrate() {
      let restored = false;
      try {
        const raw = store?.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (plausible(parsed)) {
          for (const r of parsed.revisions) Object.freeze(r.snapshot);
          state = parsed;
          restored = true;
        }
      } catch { /* corrupt or blocked storage: start from the seed */ }
      ready = true;
      emit();
      return restored;
    },
  };
}
