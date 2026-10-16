import { accountRuntime } from "@/lib/account/runtime";
import { RegisterForm } from "../_components/RegisterForm";

export const metadata = { title: "Create account" };

export default function RegisterPage() {
  const rt = accountRuntime();
  if (rt.state !== "ready") return null;
  const siteKey = rt.ctx.turnstileSecret ? rt.ctx.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null : null;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Create your account</h1>
      <p className="text-mist">An account lets you sign in on AzerDex. Browsing the database never requires one.</p>
      <RegisterForm turnstileSiteKey={siteKey} />
    </>
  );
}
