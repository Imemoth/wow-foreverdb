import Link from "next/link";
import { INPUTS } from "@/lib/account/inputs";
import { ConfirmPanel } from "../../_components/ConfirmPanel";

export const metadata = { title: "Confirm" };

/**
 * Landing page for the links in confirmation and recovery e-mails. GET has NO side effect: it only renders a button.
 * The token is read from the query string here (and stripped from the address bar by ConfirmPanel); it is never logged.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const parsed = INPUTS.confirm.safeParse({ type: sp.type, token_hash: sp.token_hash });
  if (!parsed.success) {
    return (
      <div className="panel space-y-3 p-6" role="alert">
        <h1 className="panel-title text-2xl">This link is incomplete</h1>
        <p className="text-mist">Open the link from your email again, or request a new one.</p>
        <p className="text-sm"><Link href="/account/login">Sign in</Link> · <Link href="/account/forgot-password">Reset password</Link></p>
      </div>
    );
  }
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">
        {parsed.data.type === "recovery" ? "Reset your password" : "Confirm your email"}
      </h1>
      <ConfirmPanel type={parsed.data.type} tokenHash={parsed.data.token_hash} />
    </>
  );
}
