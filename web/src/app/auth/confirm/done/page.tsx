export const dynamic = "force-dynamic";
export const metadata = { title: "Done", robots: { index: false, follow: false, nocache: true }, referrer: "no-referrer" as const };

const OK: Record<string, { title: string; text: string }> = {
  confirmed: { title: "All set", text: "Your email address is confirmed. A welcome message is on its way if this was your first confirmation." },
  password_reset: { title: "Password changed", text: "Your password was changed and every session was signed out." },
};
const ERR: Record<string, string> = {
  invalid_or_expired: "This link is invalid, expired or was already used. Request a new email and try again.",
  rate_limited: "Too many attempts. Please wait a few minutes and try again.",
  temporarily_unavailable: "This is temporarily unavailable. Please try the link again in a few minutes.",
  invalid_request: "This request could not be processed. Open the link from your email again.",
};

export default async function DonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ok = typeof sp.kind === "string" ? OK[sp.kind] : undefined;
  const err = typeof sp.error === "string" ? (ERR[sp.error] ?? ERR.invalid_request) : undefined;
  return (
    <div className="mx-auto max-w-md space-y-3">
      <div className="panel space-y-2 p-6" role={ok ? "status" : "alert"}>
        <h1 className="panel-title text-2xl">{ok ? ok.title : "That did not work"}</h1>
        <p className="text-mist">{ok ? ok.text : (err ?? ERR.invalid_request)}</p>
      </div>
    </div>
  );
}
