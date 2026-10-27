import Link from "next/link";
import { DataNote } from "@/components/DataNote";
import { joinNames, treeRankCount } from "@/lib/classes/facts";
import type { Talent, TalentTree } from "@/lib/talents/types";
import type { GuideBodyProps } from "../spec-guides";

/**
 * Priest - Shadow Magic. Everything below is computed from the verified talent data (the source note under the
 * calculator names the build), so it cannot drift from the calculator. What the data cannot say - what a talent
 * does, numbers, rotations, strengths and weaknesses - is stated as not yet verified instead of being filled in
 * from Classic-era memory or third-party guides.
 */

function requiredTalents(tree: TalentTree, t: Talent): string[] {
  return (t.requires ?? []).map((r) => tree.talents.find((x) => x.id === r.talentId)?.name).filter((n): n is string => Boolean(n));
}

/** "Blackout", "Blackout or Mind Flay" (any-of), "A and B" (all-of). */
function needsText(tree: TalentTree, t: Talent): string | null {
  const names = requiredTalents(tree, t);
  if (names.length === 0) return null;
  const anyOf = (t.requires ?? []).every((r) => r.rule === "any");
  return anyOf ? names.join(" or ") : joinNames(names);
}

export function PriestShadowGuide({ data, tree, calculator }: GuideBodyProps) {
  const rows = [...new Set(tree.talents.map((t) => t.row))].sort((a, b) => a - b);
  const lastRow = rows[rows.length - 1]!;
  const capstones = tree.talents.filter((t) => t.row === lastRow);
  const firstTier = tree.talents.filter((t) => t.row === 0);
  const linked = tree.talents.filter((t) => (t.requires?.length ?? 0) > 0);
  const otherTrees = data.trees.filter((t) => t.id !== tree.id);
  const budget = data.pointBudget.total;
  const capstoneGate = capstones[0]?.pointsRequired;

  return (
    <div className="space-y-12">
      <section id="overview" aria-labelledby="overview-title" className="space-y-4">
        <h2 id="overview-title" className="panel-title text-2xl">Overview</h2>

        <h3 className="text-lg font-semibold text-parchment">What is a Shadow Priest?</h3>
        <p className="text-mist">
          In WoW: Forever the Priest has three talent trees: {joinNames(data.trees.map((t) => t.name))}. This guide covers the
          last of them, <strong className="text-parchment">{tree.name}</strong>, which AzerDex shortens to &ldquo;Shadow&rdquo; in its web
          address. A Shadow Priest is a Priest whose talent points go mainly into this tree.
        </p>
        <ul className="grid gap-3 sm:grid-cols-3">
          <li className="panel p-4"><p className="text-xs uppercase tracking-wide text-mist">Talents in the tree</p><p className="font-mono text-2xl text-gold-300">{tree.talents.length}</p></li>
          <li className="panel p-4"><p className="text-xs uppercase tracking-wide text-mist">Ranks in total</p><p className="font-mono text-2xl text-gold-300">{treeRankCount(tree)}</p></li>
          <li className="panel p-4"><p className="text-xs uppercase tracking-wide text-mist">Tiers</p><p className="font-mono text-2xl text-gold-300">{rows.length}</p></li>
        </ul>

        <h3 className="text-lg font-semibold text-parchment">Playstyle, strengths, weaknesses and role</h3>
        <DataNote tone="warn">
          <strong className="text-parchment">Not verified yet.</strong> The game data tells us which talents exist and how they connect, but
          not what they do or how well. AzerDex does not carry Classic-era behaviour over to Forever or copy other sites&apos; guides, so this
          guide does not describe playstyle, strengths and weaknesses, or the Shadow Priest&apos;s role until those can be backed by verified
          Forever text. The rest of this page is limited to what the data does show.
        </DataNote>
      </section>

      <section id="talents" aria-labelledby="talents-title" className="space-y-4">
        <h2 id="talents-title" className="panel-title text-2xl">Talents</h2>
        <p className="text-mist">
          Try builds below. All three Priest trees share one pool of {budget} points; the {tree.name} tree is outlined. Your build is kept in the
          page address, so you can copy it with <em>Share build</em>.
        </p>
        {calculator}

        <h3 className="text-lg font-semibold text-parchment">The {tree.name} tree at a glance</h3>
        <div className="panel overflow-x-auto">
          <table className="data-table w-full text-sm">
            <caption className="sr-only">Talents of the {tree.name} tree by tier</caption>
            <thead>
              <tr><th scope="col">Tier</th><th scope="col">Talent</th><th scope="col" className="num">Max rank</th><th scope="col">Needs</th></tr>
            </thead>
            <tbody>
              {tree.talents.map((t) => {
                const prereq = needsText(tree, t);
                const parts = [
                  t.pointsRequired ? `${t.pointsRequired} points in tree${t.pointsRequiredScope === "assumed-tree" ? "†" : ""}` : null,
                  prereq ? `${prereq}` : null,
                ].filter(Boolean);
                return (
                  <tr key={t.id}>
                    <td>{t.row + 1}</td>
                    <th scope="row" className="text-left font-medium text-parchment">{t.name}</th>
                    <td className="num">{t.maxRank}</td>
                    <td className="text-mist">{parts.length ? parts.join(" · ") : "Nothing"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-mist">† The game data gives this amount but not where points are counted; the calculator applies it per tree, like every confirmed tier.</p>

        <h3 className="text-lg font-semibold text-parchment">How the tree is wired</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-mist">
          <li>
            <strong className="text-parchment">Tier 1 is open from the start:</strong> {joinNames(firstTier.map((t) => t.name))} need no points or prerequisites.
          </li>
          {linked.map((t) => (
            <li key={t.id}>
              <strong className="text-parchment">{t.name}</strong> (tier {t.row + 1}) is linked to {needsText(tree, t)}.
            </li>
          ))}
          {capstones.length > 0 && (
            <li>
              <strong className="text-parchment">{joinNames(capstones.map((t) => t.name))}</strong> {capstones.length === 1 ? "is" : "are"} alone on the last tier
              {capstoneGate ? ` and ${capstones.length === 1 ? "needs" : "need"} ${capstoneGate} points already spent in this tree` : ""}.
            </li>
          )}
        </ul>
        <p className="text-sm text-mist">
          What each talent <em>does</em> is not shown here for the same reason as above: no verified Forever description text is available yet.
        </p>
      </section>

      <section id="beginner" aria-labelledby="beginner-title" className="space-y-4">
        <h2 id="beginner-title" className="panel-title text-2xl">Beginner guide</h2>
        <h3 className="text-lg font-semibold text-parchment">Plan the points, not just the talents</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-mist">
          <li>
            A tier opens only after you have spent enough points on the tiers above it: 5 points for tier 2, 10 for tier 3, and so on in steps of 5. The
            calculator counts these points per tree, so points in {joinNames(otherTrees.map((t) => t.name))} do not help {tree.name} tiers (the client data
            confirms this for most tiers; see † above for the rest).
          </li>
          {capstoneGate !== undefined && (
            <li>
              Reaching the last tier costs {capstoneGate} points in {tree.name}, which leaves {budget - capstoneGate} of your {budget} points for everything else, including other trees.
            </li>
          )}
          <li>
            The calculator treats a linked talent as unlocked only when the talent it depends on is at its maximum rank. That is the usual reading but it
            has not been confirmed in the Forever client, so double-check anything critical in game.
          </li>
          <li>You can take a point back only while every talent that depends on it still meets its requirements. If a point will not come off, a later tier or a linked talent is holding it.</li>
        </ul>

        <h3 className="text-lg font-semibold text-parchment">Using the calculator</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-mist">
          <li>Start in the {tree.name} tree and fill tier 1; the calculator shows exactly what is still missing for any locked talent.</li>
          <li>Watch the <em>Remaining</em> counter: it is shared by all trees, so spending in one tree is a choice against the others.</li>
          <li>Use <em>Share build</em> to copy a link. A link only restores on the same version of the talent data and is refused if it breaks the rules.</li>
        </ol>

        <h3 className="text-lg font-semibold text-parchment">Before you rely on this</h3>
        <DataNote>
          The talent data comes from the Forever <strong className="text-parchment">beta</strong> client and has not been confirmed for the release client.
          The source note under the calculator names the build it was checked against. See <Link href="/guides/classes">all class guides</Link> or open
          the <Link href="/guides/classes/priest#talents">full Priest calculator</Link>.
        </DataNote>
      </section>
    </div>
  );
}
