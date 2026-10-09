import { Breadcrumbs } from "@/components/Breadcrumbs";
import { pageContext } from "@/lib/page";

export const metadata = { title: "Privacy", description: "What the ForeverDB website stores and why.", alternates: { canonical: "/about/privacy" } };

export default async function PrivacyPage() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Privacy" }]} />
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Privacy</h1>
      <div className="prose-fdb">
        <p>The ForeverDB website has no accounts, no advertising and no third-party analytics or tracking scripts.</p>
        <h2>Cookies</h2>
        <ul>
          <li><code>fdb_sid</code> — a random identifier used only to apply fair-use rate limits. It is not linked to any personal data and expires after 30 days.</li>
          <li><code>fdb_pass</code> — set only if you complete a human-verification challenge; it expires after 30 minutes.</li>
        </ul>
        <h2>Abuse protection</h2>
        <p>
          To keep the database available, request counters are kept per network address and per session for a few minutes.
          Addresses are stored only as keyed hashes in those short-lived counters, and are not written to our logs.
        </p>
        <h2>Game data</h2>
        <p>
          Published database statistics are aggregates. The website does not receive installation identifiers, character
          names, Guildbook rosters or account information from the ForeverDB backend.
        </p>
      </div>
    </article>
  );
}
