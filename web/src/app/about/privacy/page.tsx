import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PrivacyContent } from "@/components/PrivacyContent";
import { pageContext } from "@/lib/page";
import { speedInsightsEnabled } from "@/lib/speed-insights";

export const metadata = {
  title: "Privacy",
  description: "What the AzerDex website and accounts store and process, and why.",
  alternates: { canonical: "/about/privacy" },
};

export default async function PrivacyPage() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Privacy" }]} />
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Privacy</h1>
      <PrivacyContent speedInsights={speedInsightsEnabled()} />
    </article>
  );
}
