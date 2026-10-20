import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DownloadHero } from "@/components/download/DownloadHero";
import { SectionNav } from "@/components/download/SectionNav";
import { FeatureRow } from "@/components/download/FeatureRow";
import { SupportingFeatureCard } from "@/components/download/SupportingFeatureCard";
import { HowItWorksPipeline } from "@/components/download/HowItWorksPipeline";
import { MediaSlotGallery } from "@/components/download/MediaSlotGallery";
import { InstallSteps, ReleaseBoundaryNote } from "@/components/download/InstallSteps";
import { FaqAccordion, SupportLinks } from "@/components/download/FaqAccordion";
import { ADDON_MEDIA_SLOTS, COMPANION_MEDIA_SLOTS } from "@/lib/download/media-slots";
import { pageContext } from "@/lib/page";

export const metadata = {
  title: "Addon & Companion",
  description: "Get the ForeverDB addon and Companion to collect and sync observations for AzerDex.",
  alternates: { canonical: "/download" },
};

const REPO = "https://github.com/Imemoth/wow-foreverdb";

export default async function DownloadPage() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Addon & Companion" }]} />

      <DownloadHero eyebrow="Power your discovery">
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment sm:text-5xl lg:text-6xl">
          Addon &amp; Companion
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-mist sm:text-base lg:text-lg">
          Collect what you discover. Explore what the community knows.
        </p>
        <p className="mt-3 max-w-2xl text-xs text-mist/90 sm:text-sm">
          The <strong className="text-parchment">ForeverDB addon</strong> and <strong className="text-parchment">Windows
          Companion</strong> are the in-game collector and desktop tools that gather observations; the{" "}
          <strong className="text-parchment">AzerDex website</strong> you&apos;re on now presents the approved,
          aggregated result. Both tools are in <strong className="text-parchment">alpha</strong>.
        </p>
      </DownloadHero>

      <SectionNav />

      <section id="overview" aria-labelledby="overview-title" className="scroll-mt-20 space-y-3">
        <h2 id="overview-title" className="panel-title text-2xl">Overview</h2>
        <p className="max-w-3xl text-sm text-mist sm:text-base">
          ForeverDB grows from players who run the collector. The addon watches what you naturally do in-game -
          looting, gathering, fishing, disenchanting - and records it locally. The Windows Companion reads that export
          and adds search, maps built from your own game install, synchronization and a Guildbook. Nothing reaches
          this website directly: every public figure here passes through a separate, owner-reviewed publication step
          first - see <Link href="#how-it-works">how it works</Link> below.
        </p>
      </section>

      <section id="addon" aria-labelledby="addon-title" className="scroll-mt-20 space-y-6">
        <h2 id="addon-title" className="panel-title text-2xl">ForeverDB in-game Addon</h2>
        <FeatureRow
          image="/cards/tools-guides.webp"
          focalClass="object-[50%_35%]"
          medallion="/library/medallions/compendium.webp"
          title="Loot, gathering & tooltip observations"
          description="The addon watches creature loot and skinning, mining and herbalism nodes, fishing and fishing pools, containers and GameObjects, and disenchant results - then adds observed-rate statistics directly to item tooltips."
          bullets={[
            "Creature loot and skinning observations",
            "Mining and herbalism nodes",
            "Fishing and fishing pools",
            "Containers and GameObjects",
            "Item tooltips with observed drop statistics",
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SupportingFeatureCard icon="/icons/creatures.webp" title="Creature loot & skinning" description="Tracks what drops from creatures and skinning, with sample counts." />
          <SupportingFeatureCard icon="/icons/mining.webp" title="Mining" description="Records ore and mineral nodes as you gather them." />
          <SupportingFeatureCard icon="/icons/herbalism.webp" title="Herbalism" description="Records herb nodes as you gather them." />
          <SupportingFeatureCard icon="/icons/fishing.webp" title="Fishing & fishing pools" description="Tracks catches and the fishing pools they come from." />
          <SupportingFeatureCard title="Containers & GameObjects" description="Chests and other lootable objects are tracked alongside creature loot." />
          <SupportingFeatureCard icon="/icons/items.webp" title="Item tooltips" description="Observed source and rate statistics appear directly on the item tooltip." />
          <SupportingFeatureCard title="Session Tracker" description="An in-game HUD showing XP, gold and session timing while you play." />
          <SupportingFeatureCard title="Commands & diagnostics" description={<>{"Slash commands ("}<code>/fdb status</code>{", "}<code>/fdb last</code>{", "}<code>/fdb item &lt;id&gt;</code>{") report collector health and the most recent observation."}</>} />
        </div>
        <div>
          <h3 className="panel-title text-lg">Screenshots</h3>
          <div className="mt-3">
            <MediaSlotGallery slots={ADDON_MEDIA_SLOTS} />
          </div>
        </div>
        <a className="btn-primary" href={`${REPO}/tree/main/addon/ForeverDB`} rel="noopener noreferrer">View addon source</a>
      </section>

      <section id="companion" aria-labelledby="companion-title" className="scroll-mt-20 space-y-6">
        <h2 id="companion-title" className="panel-title text-2xl">ForeverDB Windows Companion</h2>
        <FeatureRow
          reverse
          image="/cards/interactive-maps.webp"
          focalClass="object-[55%_40%]"
          medallion="/library/medallions/cartography.webp"
          title="Multi-zone map viewer"
          description="Browse an interactive map built from your own game install for every zone you've collected in, with markers, clustering and heatmaps for observed sources."
          bullets={[
            "Every zone you've collected in, on one map",
            "Markers, clusters and heatmaps",
            "Built from your own game install, never redistributed map art",
          ]}
        />
        <FeatureRow
          image="/cards/exploration-discovery.webp"
          focalClass="object-[30%_55%]"
          medallion="/library/medallions/discovery.webp"
          title="Search & database browsing"
          description="Search and browse your own collected observations from the desktop, with full item and source detail navigation - the same database experience as this website, built from your own data."
          bullets={[
            "Search and database browsing",
            "Item and source detail navigation",
            "SavedVariables monitoring",
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <SupportingFeatureCard icon="/cards/medallions/community-data.webp" title="Guildbook" description="A roster and recipe view built from your guild's shared observations." />
          <SupportingFeatureCard icon="/library/medallions/wayfinder.webp" title="Installation & sync status" description="See whether your installation's data is up to date at a glance." />
          <SupportingFeatureCard icon="/library/medallions/discovery.webp" title="Manual synchronization" description="Trigger a Sync Now at any time to push your latest export." />
          <SupportingFeatureCard title="Automatic synchronization" description="Background sync without a manual trigger, rolling out gradually." pending />
          <SupportingFeatureCard title="Account sign-in & registered devices" description="AzerDex account linking and multi-device sync are being rolled out separately." pending />
        </div>
        <div>
          <h3 className="panel-title text-lg">Screenshots</h3>
          <div className="mt-3">
            <MediaSlotGallery slots={COMPANION_MEDIA_SLOTS} />
          </div>
        </div>
        <a className="btn-ghost" href={REPO} rel="noopener noreferrer">Project &amp; build instructions</a>
      </section>

      <section id="how-it-works" aria-labelledby="how-it-works-title" className="scroll-mt-20 space-y-3">
        <h2 id="how-it-works-title" className="panel-title text-2xl">How AzerDex works</h2>
        <p className="max-w-3xl text-sm text-mist">
          The addon collects observations locally. The Companion synchronizes permitted observations to a private
          backend. Private records stay in that protected backend - a separate publication process validates and
          aggregates approved public statistics before anything reaches this website. The current public beta
          continues to use clearly labeled synthetic sample data while that pipeline is finished.
        </p>
        <HowItWorksPipeline />
        <p className="text-sm text-mist">
          Read the full explanation, including what &quot;observed&quot; means and why sample sizes matter, on{" "}
          <Link href="/about/data">how the data works</Link>.
        </p>
      </section>

      <section id="installation" aria-labelledby="installation-title" className="scroll-mt-20 space-y-4">
        <h2 id="installation-title" className="panel-title text-2xl">Installation</h2>
        <InstallSteps />
        <ReleaseBoundaryNote />
      </section>

      <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 space-y-4">
        <h2 id="faq-title" className="panel-title text-2xl">FAQ &amp; Support</h2>
        <FaqAccordion />
        <SupportLinks />
      </section>
    </div>
  );
}
