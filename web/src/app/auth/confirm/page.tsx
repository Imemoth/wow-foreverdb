import { TOKEN_HASH, isConfirmType } from "@/lib/auth-confirm/forward";

export const dynamic = "force-dynamic";
export const metadata = { title: "Confirm", robots: { index: false, follow: false, nocache: true }, referrer: "no-referrer" as const };

const FORM_ERRORS: Record<string, string> = {
  password_mismatch: "The two passwords do not match.",
  weak_password: "That password is too weak. Choose a longer, less common one.",
  same_password: "Choose a password you have not used before.",
  invalid_password: "That password is not acceptable. Use 8 to 72 characters.",
};

/**
 * Landing page for the links in AzerDex account e-mails. GET has NO side effect: it only renders a button, so a mail scanner that prefetches the link cannot
 * use the one-time token up. The token is consumed only by the explicit POST to /auth/confirm/submit. Works regardless of the Account feature flags.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const type = typeof sp.type === "string" ? sp.type : "";
  const tokenHash = typeof sp.token_hash === "string" ? sp.token_hash : "";
  const error = typeof sp.error === "string" ? FORM_ERRORS[sp.error] : undefined;
  if (!isConfirmType(type) || !TOKEN_HASH.test(tokenHash)) {
    return (
      <div className="mx-auto max-w-md space-y-3">
        <div className="panel space-y-2 p-6" role="alert">
          <h1 className="panel-title text-2xl">This link is incomplete or not supported</h1>
          <p className="text-mist">Open the link from your most recent AzerDex email again, or request a new email.</p>
        </div>
      </div>
    );
  }
  const recovery = type === "recovery";
  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">
        {recovery ? "Choose a new password" : type === "email_change" ? "Confirm your email change" : "Confirm your email"}
      </h1>
      <form method="post" action="/auth/confirm/submit" className="panel space-y-4 p-6">
        <input type="hidden" name="type" value={type} />
        <input type="hidden" name="token_hash" value={tokenHash} />
        {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
        <p className="text-mist">
          {recovery ? "Choose a new password for your AzerDex account." : "Press the button to confirm."} Nothing happens until you do, so automatic link scanners cannot use up your link.
        </p>
        {recovery ? (
          <>
            <label className="block space-y-1 text-sm">
              <span>New password</span>
              <input type="password" name="password" required minLength={8} maxLength={72} autoComplete="new-password" className="w-full rounded border border-white/20 bg-black/30 px-3 py-2" />
            </label>
            <label className="block space-y-1 text-sm">
              <span>Repeat new password</span>
              <input type="password" name="password_confirm" required minLength={8} maxLength={72} autoComplete="new-password" className="w-full rounded border border-white/20 bg-black/30 px-3 py-2" />
            </label>
          </>
        ) : null}
        <button type="submit" className="btn-gold w-full">{recovery ? "Set new password" : type === "email_change" ? "Confirm email change" : "Confirm email address"}</button>
      </form>
    </div>
  );
}
