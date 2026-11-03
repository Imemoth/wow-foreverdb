import type { ApiReply } from "./client";

/**
 * Signed-in state for the site header, shared by every header Account entry on the page (the desktop button and the
 * mobile menu, which only mounts while it is open). One load per page: a late-mounting instance reads the answer that
 * is already there instead of starting from "unknown" and flashing the guest link. Isomorphic and secret-free: the
 * only input is the reply of the same-origin /account/api/me call (cookie-based; no token ever reaches JavaScript).
 */
export type HeaderAccountStatus = "unknown" | "guest" | "authed";

export function createHeaderStatusStore(load: () => Promise<ApiReply>) {
  let status: HeaderAccountStatus = "unknown";
  let inFlight = false;
  const listeners = new Set<() => void>();
  const set = (next: HeaderAccountStatus) => {
    if (next === status) return;
    status = next;
    for (const l of listeners) l();
  };
  return {
    getSnapshot: () => status,
    getServerSnapshot: (): HeaderAccountStatus => "unknown",
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Starts the single lookup. A definite answer is final for this page load; a failed one (network, 404, 503, 5xx) may be retried. */
    ensureLoaded() {
      if (status !== "unknown" || inFlight) return;
      inFlight = true;
      load()
        .then((r) => {
          if (r.status === 401) set("guest");
          else if (r.status === 200) set(r.data.ok === true ? "authed" : "guest");
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    },
  };
}
