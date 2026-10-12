import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accountRuntime } from "@/lib/account/runtime";

// Every account page is per-request: never statically generated, never shared-cached (see also proxy.ts headers).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: { default: "Account", template: "%s · ForeverDB account" },
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AccountLayout({ children }: { children: React.ReactNode }) {
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
  // Narrow by default (forms); a page that renders an element with `data-account-wide` (installation list, Guildbook) widens it.
  return <div className="mx-auto w-full max-w-md space-y-6 has-[[data-account-wide]]:max-w-4xl">{children}</div>;
}
