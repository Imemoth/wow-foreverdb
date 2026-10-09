import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { pageContext } from "@/lib/page";

export const metadata = {
  title: "Addon & Companion",
  description: "Get the ForeverDB in-game addon and Windows Companion to collect and sync observations.",
  alternates: { canonical: "/download" },
};

const REPO = "https://github.com/Imemoth/wow-foreverdb";

export default async function DownloadPage() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Addon & Companion" }]} />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Addon &amp; Companion</h1>
        <p className="mt-2 text-mist">ForeverDB grows from players who run the collector. Both tools are in <strong className="text-parchment">alpha</strong>.</p>
      </header>
      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="addon-title" className="panel p-6">
          <h2 id="addon-title" className="panel-title text-xl">In-game addon</h2>
          <p className="mt-2 text-sm text-mist">Collects loot, gathering, fishing and disenchant observations locally. Never makes network requests.</p>
          <ul className="mt-3 list-disc pl-5 text-sm text-mist">
            <li>Interface target: WoW: Forever (16001)</li>
            <li>Commands: <code>/fdb status</code>, <code>/fdb item &lt;id&gt;</code></li>
          </ul>
          <a className="btn-gold mt-5" href={`${REPO}/tree/main/addon/ForeverDB`} rel="noopener noreferrer">View addon source</a>
        </section>
        <section aria-labelledby="companion-title" className="panel p-6">
          <h2 id="companion-title" className="panel-title text-xl">Windows Companion</h2>
          <p className="mt-2 text-sm text-mist">Syncs your observations, and offers search, maps from your own game install, and Guildbook.</p>
          <ul className="mt-3 list-disc pl-5 text-sm text-mist">
            <li>Only the latest Companion version is supported.</li>
            <li>Signed installer and auto-update are still on the roadmap.</li>
          </ul>
          <a className="btn-ghost mt-5" href={REPO} rel="noopener noreferrer">Project &amp; build instructions</a>
        </section>
      </div>
      <p className="rounded-lg border border-ink-600 p-4 text-sm text-mist">
        A public, signed release download is not available yet; builds are currently produced by the project&apos;s GitHub
        workflows. This page will link the official release once it is published. See the{" "}
        <Link href="/guides/getting-started-with-foreverdb">getting-started guide</Link>.
      </p>
    </div>
  );
}
