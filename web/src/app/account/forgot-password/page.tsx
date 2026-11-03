import { accountRuntime } from "@/lib/account/runtime";
import { ForgotForm } from "../_components/ForgotForm";
import { PrivacyNote } from "../_ui/PrivacyNote";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  const rt = accountRuntime();
  if (rt.state !== "ready") return null;
  const siteKey = rt.ctx.turnstileSecret ? rt.ctx.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null : null;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Reset your password</h1>
      <p className="text-mist">Enter your email address and we will send you a link to choose a new password.</p>
      <PrivacyNote>We use the address only to send that link. See the</PrivacyNote>
      <ForgotForm turnstileSiteKey={siteKey} />
    </>
  );
}
