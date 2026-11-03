import Link from "next/link";
import type { ReactNode } from "react";

const REPO = "https://github.com/Imemoth/wow-foreverdb";

/**
 * Staged installation flow (P2-E Phase 5). Every step here is verified against current
 * repository behavior: the addon is source-available today and the slash commands are
 * real (`addon/ForeverDB/Core.lua`); the Companion has no signed public installer yet
 * (see docs/web/go-live-checklist.md section D and docs/VERSIONING.md - builds are
 * produced by the project's own GitHub Actions workflows, not a one-click download).
 * Steps that depend on Browser Pairing Stage C / installer signing / Windows
 * acceptance are rendered as an explicitly labeled pending step, never as if they were
 * already available - see release-boundary note at the end.
 */
export function InstallSteps() {
  return (
    <ol className="space-y-4">
      <InstallStep n={1} title="Get the ForeverDB addon">
        The addon is source-available on GitHub today. Download or clone{" "}
        <a href={`${REPO}/tree/main/addon/ForeverDB`} rel="noopener noreferrer">the addon source</a> and place the
        <code>ForeverDB</code> folder in your WoW: Forever <code>Interface/AddOns</code> directory.
      </InstallStep>
      <InstallStep n={2} title="Enable it in the client">
        Enable <strong className="text-parchment">ForeverDB</strong> from the AddOns list at the character select
        screen, then log in. It targets WoW: Forever interface <strong className="text-parchment">16001</strong>.
      </InstallStep>
      <InstallStep n={3} title="Verify it's collecting">
        Run <code>/fdb status</code> in-game to confirm the collector is active, and <code>/fdb last</code> after any
        loot, gather or fishing action to see the most recent observation.
      </InstallStep>
      <InstallStep n={4} title="Get the Windows Companion" pending>
        A signed, one-download Companion installer is not available yet. Builds are currently produced by the
        project&apos;s own GitHub Actions workflows - see the <a href={REPO} rel="noopener noreferrer">project and
        build instructions</a>. This page will link the official release once one is published.
      </InstallStep>
      <InstallStep n={5} title="Understand sync and privacy">
        The Companion reads only your own addon&apos;s exported data. Manual <strong className="text-parchment">Sync
        Now</strong> is available for an installed Companion; automatic background sync, AzerDex account sign-in and
        registered-device linking are being rolled out separately and are not required for the addon or Companion to
        work on their own.
      </InstallStep>
    </ol>
  );
}

function InstallStep({ n, title, pending, children }: { n: number; title: string; pending?: boolean; children: ReactNode }) {
  return (
    <li className={`panel flex gap-4 p-4 sm:p-5 ${pending ? "border-conf-low/40" : ""}`}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-violet-400/50 font-[family-name:var(--font-display)] text-sm font-bold text-violet-300">
        {n}
      </span>
      <div>
        <p className="flex flex-wrap items-center gap-2 font-[family-name:var(--font-display)] text-base font-semibold text-parchment">
          {title}
          {pending && <span className="rounded-full bg-conf-low/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#f5d2b4]">Pending release</span>}
        </p>
        <p className="mt-1 text-sm text-mist">{children}</p>
      </div>
    </li>
  );
}

export function ReleaseBoundaryNote() {
  return (
    <p className="rounded-lg border border-ink-600 bg-ink-850/80 p-4 text-sm text-mist">
      A public, signed Companion installer is not available yet; it depends on distribution and release work still in
      progress. This page links the project&apos;s own GitHub source and build instructions in the meantime, and will
      link the official release once it is published. See the{" "}
      <Link href="/guides/getting-started-with-foreverdb">getting-started guide</Link>.
    </p>
  );
}
