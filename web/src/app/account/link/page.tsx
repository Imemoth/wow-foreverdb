import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePageUser } from "@/lib/account/page-session";
import { Unavailable } from "../_ui/Unavailable";
import { LinkForm } from "../_components/LinkForm";
import { PrivacyNote } from "../_ui/PrivacyNote";

export const metadata = { title: "Link an installation" };

/** GET renders the form only: nothing here changes ownership. The redemption is a CSRF-protected POST with a fresh password. */
export default async function LinkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // A linking code is never accepted from, or kept in, a URL: any query string is dropped with a redirect to the bare path, so a
  // pasted-into-the-address-bar code is not echoed into the page, the history entry or a Referer (the form never reads the query).
  if (Object.keys(await searchParams).length > 0) redirect("/account/link");
  const p = await requirePageUser("/account/link");
  if (!p.ok) return p.reason === "unavailable" ? <Unavailable /> : null;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Link a Companion installation</h1>
      <section className="panel space-y-3 p-6" aria-labelledby="dest-h">
        <h2 id="dest-h" className="panel-title text-lg">Destination account</h2>
        <p className="text-sm text-mist">The installation will be transferred to this account:</p>
        <p className="break-all text-lg text-parchment" data-testid="link-destination">{p.user.email}</p>
        <p className="text-xs text-mist">Not your account? <Link href="/account">Go back</Link> and sign out before continuing.</p>
      </section>
      <section className="panel space-y-2 p-6" aria-labelledby="how-h">
        <h2 id="how-h" className="panel-title text-lg">How it works</h2>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-parchment">
          <li>Open the ForeverDB Companion and go to the <strong>ACCOUNT</strong> tab.</li>
          <li>Generate a linking code for the installation and copy it. It is valid for 10 minutes and works once.</li>
          <li>Paste it below, enter your password again and confirm.</li>
        </ol>
        <p className="text-sm text-mist">
          Linking moves the installation and its observation history to this account. The Guildbook stays on your computer and is
          not part of an account. Only a code created by the Companion that currently owns the installation can be redeemed. Never
          share a code with anyone.
        </p>
        <p className="text-sm text-mist">
          You will be asked for this account&apos;s password. If you do not know it, someone else may have registered your address
          before you: do not link anything, <Link href="/account/forgot-password">reset the password</Link> first.
        </p>
        <PrivacyNote anchor="companion">
          Linking associates the installation identifier with this account and records a linking event. What the Companion sends
          (public observations only; the Guildbook stays on your computer) is described in the Addon and Companion section of the
        </PrivacyNote>
      </section>
      <LinkForm email={p.user.email} accountId={p.user.id} />
    </>
  );
}
