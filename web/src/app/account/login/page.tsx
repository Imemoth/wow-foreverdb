import { safeNext } from "@/lib/account/contracts";
import { LOGIN_REASONS } from "@/lib/account/messages";
import { LoginForm } from "../_components/LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ reason?: string; next?: string }> }) {
  const sp = await searchParams;
  // Only reasons from the closed list are displayed (never reflected text); `next` is re-validated by the server on submit.
  const reason = typeof sp.reason === "string" && Object.hasOwn(LOGIN_REASONS, sp.reason) ? LOGIN_REASONS[sp.reason] : undefined;
  const next = typeof sp.next === "string" ? safeNext(sp.next) : undefined;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Sign in</h1>
      {reason && (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${reason.tone === "warn" ? "border-conf-medium/40 bg-conf-medium/10 text-conf-medium" : "border-ink-600 bg-ink-850 text-parchment"}`}>
          {reason.text}
        </p>
      )}
      <LoginForm next={next} />
    </>
  );
}
