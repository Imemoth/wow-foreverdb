import Link from "next/link";
import { cookies } from "next/headers";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, readSession, recoverySessionActive } from "@/lib/account/session";
import { ResetForm } from "../_components/ResetForm";
import { PrivacyNote } from "../_ui/PrivacyNote";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  const rt = accountRuntime();
  if (rt.state !== "ready") return null;
  const store = await cookies();
  // Presence only: the POST validates the recovery session with Auth. This page just avoids showing a dead form.
  const { session } = await readSession(rt.ctx.cfg.csrfSecret, jarFrom(() => store.getAll()), rt.ctx.https);
  const active = recoverySessionActive(session);
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Choose a new password</h1>
      <PrivacyNote>Your password is handled by our authentication service (Supabase Auth). See the</PrivacyNote>
      {active ? (
        <ResetForm />
      ) : (
        <div className="panel space-y-3 p-6">
          <p className="text-mist">This page needs a valid password-reset link. The link may have expired or already been used.</p>
          <Link className="btn-primary" href="/account/forgot-password">Request a new link</Link>
        </div>
      )}
    </>
  );
}
