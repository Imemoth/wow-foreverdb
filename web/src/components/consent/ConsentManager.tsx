"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  PRIVACY_NOTICE_VERSION,
  getConsentSettingsOpen,
  hasAnalyticsConsent,
  isCurrentDecision,
  parseConsentRecord,
  readConsentRaw,
  setConsentSettingsOpen,
  subscribeConsent,
  subscribeConsentSettings,
  writeConsent,
  type ConsentRecord,
} from "@/lib/consent";

/**
 * The optional-measurement scripts are code-split and loaded ONLY after an affirmative choice: before it (and after a refusal or a
 * withdrawal) neither the Vercel component, nor its script, nor any request to Vercel exists in the page.
 */
const TrafficAnalytics = dynamic(() => import("@/components/TrafficAnalytics").then((m) => m.TrafficAnalytics), { ssr: false });
const TrafficSpeedInsights = dynamic(() => import("@/components/TrafficSpeedInsights").then((m) => m.TrafficSpeedInsights), { ssr: false });

/** What the server renders and what the client sees while hydrating: "unknown", so nothing flashes for a returning visitor. */
const UNKNOWN = "\u0000unknown";

type Props = {
  /** Server-decided: a real public AzerDex host (or the local e2e harness). When false no analytics can ever load, whatever is stored. */
  analyticsAvailable: boolean;
  /** Server-decided: analyticsAvailable AND the AZERDEX_SPEED_INSIGHTS flag. */
  speedInsightsAvailable: boolean;
};

const BUTTON = "min-h-11";

export function ConsentManager({ analyticsAvailable, speedInsightsAvailable }: Props) {
  const raw = useSyncExternalStore(subscribeConsent, readConsentRaw, () => UNKNOWN);
  const settingsOpen = useSyncExternalStore(subscribeConsentSettings, getConsentSettingsOpen, () => false);
  const [announcement, setAnnouncement] = useState("");

  const ready = raw !== UNKNOWN;
  const record = ready ? parseConsentRecord(raw) : null;
  const decided = isCurrentDecision(record);
  const granted = ready && hasAnalyticsConsent(record);

  const choose = (analytics: boolean) => {
    writeConsent(analytics);
    setConsentSettingsOpen(false);
    setAnnouncement(analytics ? "Analytics allowed. You can change this from Cookie settings in the footer." : "Optional analytics refused. You can change this from Cookie settings in the footer.");
  };

  return (
    <>
      {/* Polite announcement of the saved choice for screen readers; always mounted so it is announced when its text changes. */}
      <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
      {ready && settingsOpen && <ConsentSettings record={decided ? record : null} onSave={choose} onClose={() => setConsentSettingsOpen(false)} />}
      {ready && !settingsOpen && !decided && <ConsentBanner onChoose={choose} onSettings={() => setConsentSettingsOpen(true)} />}
      {granted && analyticsAvailable && <TrafficAnalytics />}
      {granted && speedInsightsAvailable && <TrafficSpeedInsights />}
    </>
  );
}

function ConsentBanner({ onChoose, onSettings }: { onChoose: (analytics: boolean) => void; onSettings: () => void }) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-consent="banner"
      className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto border-t border-ink-600 bg-ink-900 p-4 text-sm text-parchment shadow-[0_-8px_24px_rgb(0_0_0/0.5)]"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="max-w-3xl space-y-1.5">
          <p id={titleId} className="font-[family-name:var(--font-display)] text-base text-gold-300">Cookies and analytics</p>
          <p className="leading-relaxed text-mist">
            AzerDex uses a few essential cookies so the site, sign-in and fair-use limits work; they are always on. With your
            permission it also uses Vercel Web Analytics to count visits to public pages. Analytics is optional and the site works
            the same without it. You can change your choice at any time from &ldquo;Cookie settings&rdquo; in the footer. See the{" "}
            <Link href="/about/privacy">privacy notice</Link>.
          </p>
        </div>
        {/* Accept and Reject are identical in size, style and position-in-flow: neither is visually favoured. */}
        <div className="grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 md:w-[26rem]">
          <button type="button" className={`btn-primary ${BUTTON} justify-center`} onClick={() => onChoose(true)}>Accept analytics</button>
          <button type="button" className={`btn-primary ${BUTTON} justify-center`} onClick={() => onChoose(false)}>Reject optional</button>
          <button type="button" className={`btn-ghost ${BUTTON} col-span-2 justify-center sm:col-span-1`} onClick={onSettings}>Settings</button>
        </div>
      </div>
    </section>
  );
}

function ConsentSettings({ record, onSave, onClose }: { record: ConsentRecord | null; onSave: (analytics: boolean) => void; onClose: () => void }) {
  const titleId = useId();
  const descId = useId();
  const checkboxId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Nothing is preselected: the box starts from the visitor's stored choice, and unchecked when there is none.
  const [analytics, setAnalytics] = useState(record?.analytics === true);

  useEffect(() => {
    // Opened by the visitor (banner or footer link): move focus into the panel, hand it back to the opener when it closes.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-consent="settings"
      onKeyDown={onKeyDown}
      className="fixed inset-x-0 bottom-0 z-50 max-h-[90vh] overflow-y-auto border-t border-ink-600 bg-ink-900 p-4 text-sm text-parchment shadow-[0_-8px_24px_rgb(0_0_0/0.5)]"
    >
      <div className="mx-auto max-w-3xl space-y-4">
        <h2 id={titleId} ref={headingRef} tabIndex={-1} className="font-[family-name:var(--font-display)] text-lg text-gold-300 outline-none">
          Cookie and analytics settings
        </h2>
        <p id={descId} className="leading-relaxed text-mist">
          Choose whether optional analytics may run. Your choice is saved only in this browser, is not sent to AzerDex, and applies to
          this address (for example <code>azerdex.com</code> and <code>beta.azerdex.com</code> each ask separately). Details are in the{" "}
          <Link href="/about/privacy">privacy notice</Link>.
        </p>

        <div className="rounded-lg border border-ink-700 p-3">
          <p className="font-semibold text-parchment">Essential &mdash; always on</p>
          <p className="mt-1 leading-relaxed text-mist">
            Fair-use rate limiting, human verification, sign-in and anti-forgery protection for accounts, and remembering this choice.
            They are needed to run and protect the site and do not depend on your choice here.
          </p>
        </div>

        <div className="rounded-lg border border-ink-700 p-3">
          <label htmlFor={checkboxId} className="flex min-h-11 cursor-pointer items-start gap-3">
            <input
              id={checkboxId}
              type="checkbox"
              checked={analytics}
              onChange={(e) => setAnalytics(e.target.checked)}
              className="mt-1 h-5 w-5 shrink-0 accent-violet-500"
            />
            <span>
              <span className="block font-semibold text-parchment">Analytics (optional)</span>
              <span className="mt-1 block leading-relaxed text-mist">
                Allow Vercel Web Analytics to count visits to public AzerDex pages. Account and sign-in pages are never measured, and
                query strings and fragments are removed before anything is sent.
              </span>
            </span>
          </label>
        </div>

        {record ? (
          <p className="text-xs text-mist">
            Current choice: analytics {record.analytics ? "allowed" : "refused"}, saved {record.at} under privacy notice version {record.notice}.
          </p>
        ) : (
          <p className="text-xs text-mist">No choice saved yet. Privacy notice version {PRIVACY_NOTICE_VERSION}.</p>
        )}

        <div className="grid grid-cols-2 gap-2 sm:flex">
          <button type="button" className={`btn-primary ${BUTTON} justify-center`} onClick={() => onSave(analytics)}>Save choices</button>
          <button type="button" className={`btn-ghost ${BUTTON} justify-center`} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
