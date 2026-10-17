import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, resolveSession } from "@/lib/account/session";
import { SENSITIVE_PAGE_REFERRER_POLICY } from "@/lib/security/headers";
import { AccountNavLinks } from "./_components/AccountNavLinks";
import { LogoutButton } from "./_components/LogoutButton";

// Every account page is per-request: never statically generated, never shared-cached (see also proxy.ts headers).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: { default: "Account", template: "%s · AzerDex account" },
  robots: { index: false, follow: false, nocache: true },
  referrer: SENSITIVE_PAGE_REFERRER_POLICY,
};

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const rt = accountRuntime();
  if (rt.state === "disabled") notFound(); // accounts are off unless explicitly enabled and validated
  if (rt.state === "unavailable") {
    return (
      <div className="mx-auto max-w-md">
        <div className="panel space-y-2 p-6" role="alert">
          <h1 className="panel-title text-2xl">Accounts are temporarily unavailable</h1>
          <p className="text-mist">The required protections are not active on this deployment, so sign-in is switched off. Public browsing is unaffected.</p>
        </div>
      </div>
    );
  }
  // Read-only: a layout cannot set cookies, and every page re-verifies the session itself before
  // acting on it. This only decides whether to show the signed-in nav cluster above the page.
  const store = await cookies();
  const r = await resolveSession(rt.ctx.cfg, jarFrom(() => store.getAll()), rt.ctx.https, { kind: "user", canWrite: false });
  const authed = r.state === "authenticated";

  // Narrow by default (forms); a page that renders an element with `data-account-wide` (installation list, Guildbook) widens it.
  return (
    <div className="mx-auto w-full max-w-md space-y-6 has-[[data-account-wide]]:max-w-4xl">
      {authed && (
        <nav aria-label="Account" className="panel flex flex-wrap items-center gap-2 p-2 text-sm">
          <AccountNavLinks />
          <div className="ml-auto"><LogoutButton compact /></div>
        </nav>
      )}
      {children}
    </div>
  );
}
