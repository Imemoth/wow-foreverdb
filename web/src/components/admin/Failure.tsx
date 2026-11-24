import type { CmsFailure } from "@/lib/admin/cms/rpc";
import { Notice } from "./primitives";

/** Closed, plain-language rendering of a failed server read. Database text never reaches this component. */
export function Failure({ f, what }: { f: CmsFailure; what: string }) {
  const m: Record<string, { tone: "error" | "warning"; title: string; text: string }> = {
    denied: { tone: "error", title: "Access denied", text: `You are not permitted to ${what}, or your TOTP verification is older than 15 minutes. Verify again from your account if needed.` },
    unauthenticated: { tone: "warning", title: "Admin session ended", text: "Your Admin session is no longer valid. Verify TOTP again from your account." },
    unavailable: { tone: "warning", title: "Backend unavailable", text: "The CMS backend could not be reached or is not configured. Nothing is shown rather than guessing." },
    stale: { tone: "warning", title: "Out of date", text: "Reload the page." },
  };
  const d = m[f.kind] ?? { tone: "warning" as const, title: "Could not load", text: `The CMS could not ${what}. Try again.` };
  return <div data-testid="read-failure" data-kind={f.kind}><Notice tone={d.tone} role="alert" title={d.title}>{d.text}</Notice></div>;
}
