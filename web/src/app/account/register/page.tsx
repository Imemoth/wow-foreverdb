import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, resolveSession } from "@/lib/account/session";
import { RegisterForm } from "../_components/RegisterForm";

export const metadata = { title: "Create account" };

export default async function RegisterPage() {
  const rt = accountRuntime();
  if (rt.state !== "ready") return null;
  // A signed-in visitor (e.g. following the header's Account entry) goes to their account, not the registration form.
  const store = await cookies();
  const r = await resolveSession(rt.ctx.cfg, jarFrom(() => store.getAll()), rt.ctx.https, { kind: "user", canWrite: false });
  if (r.state === "authenticated") redirect("/account");
  const siteKey = rt.ctx.turnstileSecret ? rt.ctx.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null : null;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Create your account</h1>
      <p className="text-mist">An account lets you sign in on AzerDex. Browsing the database never requires one.</p>
      <p className="text-sm text-mist">Already have an account? <Link href="/account/login">Sign in</Link></p>
      <RegisterForm turnstileSiteKey={siteKey} />
    </>
  );
}
