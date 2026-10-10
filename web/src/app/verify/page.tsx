import Link from "next/link";
import { TurnstileWidget } from "@/components/TurnstileWidget";
import { serverEnv } from "@/lib/env";

export const metadata = { title: "Verify", robots: { index: false, follow: false } };

export default function VerifyPage() {
  const env = serverEnv();
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Quick check</h1>
      <p className="text-mist">You have been searching quickly. Please confirm you are human to continue at the normal rate.</p>
      {env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ? (
        <TurnstileWidget siteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY} />
      ) : (
        <p className="text-sm text-mist">Human verification is not enabled on this deployment. Please wait a minute and try again.</p>
      )}
      <Link href="/database" className="btn-ghost">Back to the database</Link>
    </div>
  );
}
