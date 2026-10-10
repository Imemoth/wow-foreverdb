import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { fmtDateTime } from "@/lib/format";
import { pageContext } from "@/lib/page";

export const metadata = {
  title: "How the data works",
  description: "How ForeverDB collects, aggregates and publishes observed WoW: Forever loot and gathering data, and how to read observed drop rates.",
  alternates: { canonical: "/about/data" },
};

export default async function AboutDataPage() {
  const { db, nonce, baseUrl } = await pageContext();
  const meta = await db.meta();
  const t = meta.thresholds ?? {};
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "How the data works" }]} />
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">How the data works</h1>
      <div className="prose-fdb">
        <p>
          ForeverDB is an <strong>observation database</strong>. Nothing here is datamined or copied from game files: every
          number comes from what players running the ForeverDB addon actually saw while playing World of Warcraft: Forever.
        </p>

        <h2 id="pipeline">From your bags to this page</h2>
        <ol>
          <li><strong>Addon.</strong> Records each loot window with its source (creature by exact level, gathering node, fishing zone, fishing pool, chest or disenchanted item), the items and quantities, and an approximate position on a 0.5% map grid. The addon never makes network requests.</li>
          <li><strong>Companion.</strong> The Windows Companion uploads aggregated counters for your installation to the private ForeverDB backend.</li>
          <li><strong>Publication.</strong> A separate, one-way publication job reads only approved aggregate statistics, validates and sanitizes them, and writes them to an isolated public database that powers this website. Private data — installation identifiers, Guildbook rosters, accounts, tokens — is never copied here.</li>
        </ol>

        <h2 id="rates">Reading observed drop rates</h2>
        <p>
          <strong>Observed drop rate</strong> = how many observed loots from a source contained the item ÷ how many loots from that source and method were observed in total.
          It is a <em>sample rate</em>, not Blizzard&apos;s drop chance. In particular, a completely empty corpse may not be recorded, which can make rates look higher than reality.
        </p>
        <ul>
          <li><strong>Too few samples</strong>: fewer than {t.minBucketObservationsForRate ?? 10} observed loots — the rate is hidden.</li>
          <li><strong>Low sample</strong>: below {t.lowConfidenceBelow ?? 30} — shown rounded (e.g. “~40%”).</li>
          <li><strong>Moderate / High sample</strong>: shown to one decimal with a 95% Wilson interval; “high” needs at least {t.highConfidenceAtLeast ?? 100} observations.</li>
          <li><strong>Mostly one collector</strong>: most of the sample comes from a single installation, so it may reflect one player&apos;s habits. Such samples are never labelled “high”.</li>
        </ul>
        <p>
          Different creature levels, and different methods on the same creature (normal loot vs. skinning), are always kept as
          separate samples. Fishing is kept per zone, and fishing pools separately from open water.
        </p>

        <h2 id="coverage">Coverage and limits</h2>
        <ul>
          <li>Only observed entries exist here. A missing item or creature usually means nobody has recorded it yet — not that it does not exist.</li>
          <li>Herbalism and disenchanting collectors are still completing their end-to-end acceptance; treat those numbers as provisional.</li>
          <li>There is no quest catalogue yet, and profession coverage is incomplete.</li>
          <li>Zone association for items is indirect: an item is listed in a zone if one of its sources was observed there.</li>
          <li>A player can run more than one installation, and overlapping snapshots may be counted more than once; sample thresholds are not proof of distinct contributors.</li>
        </ul>

        <h2 id="maps">Why there is no map artwork</h2>
        <p>
          The Companion draws maps from your own game installation. That artwork belongs to Blizzard Entertainment and is not
          ours to redistribute, so the website shows coordinate plots on a neutral grid instead. Positions are aggregated to a
          coarse grid, and fishing-pool positions are best-effort projections.
        </p>

        <h2 id="preview">Preview builds and sample data</h2>
        <p>
          Until the isolated public database is provisioned, preview builds run on <strong>synthetic sample data</strong>
          generated from invented test inputs by the real publication pipeline. Those pages carry a permanent banner and are not
          indexed by search engines.
        </p>

        <h2 id="freshness">Freshness</h2>
        <p>
          Current dataset: {meta.mode === "synthetic-sample" ? "synthetic sample" : `publication #${meta.publicationId}`}, published {fmtDateTime(meta.publishedAt)};
          newest underlying statistic {fmtDateTime(meta.dataUpdatedAt)}.
        </p>
        <p>Questions or corrections? See the <Link href="/guides">guides</Link> or the project on GitHub.</p>
      </div>
    </article>
  );
}
