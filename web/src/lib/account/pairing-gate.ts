import type { AccountContext } from "./runtime";

/** Independent reviewed source gate. The disposable stack must also enable the database gate explicitly. */
export const BROWSER_PAIRING_WEB_APPROVED = false;

export function browserPairingWebAvailable(
  ac: Pick<AccountContext, "cfg" | "env">,
  approval: boolean = BROWSER_PAIRING_WEB_APPROVED,
): boolean {
  return approval || (ac.cfg.mode === "local" && !ac.env.hosted && ac.env.FOREVERDB_DEPLOYMENT === "local");
}
