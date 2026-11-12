import "server-only";
import { accountRuntime, type AccountContext } from "@/lib/account/runtime";

/** Hosted Admin authentication stays compiled OFF until separate staging/activation review. */
export const HOSTED_ADMIN_AUTH_APPROVED = false as boolean;

export function adminEnabled(ac: AccountContext): boolean {
  return ac.cfg.mode === "local" && !ac.env.hosted && ac.env.FOREVERDB_DEPLOYMENT === "local"
    || HOSTED_ADMIN_AUTH_APPROVED && ac.cfg.mode === "staging" && ac.env.FOREVERDB_DEPLOYMENT === "preview";
}

export function adminRuntime(): { state: "disabled" | "unavailable" } | { state: "ready"; ac: AccountContext } {
  const rt = accountRuntime();
  if (rt.state === "disabled") return { state: "disabled" };
  if (rt.state === "unavailable") return { state: "unavailable" };
  return adminEnabled(rt.ctx) ? { state: "ready", ac: rt.ctx } : { state: "disabled" };
}
