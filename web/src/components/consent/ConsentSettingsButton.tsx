"use client";

import { openConsentSettings } from "@/lib/consent";

/**
 * The permanent way to review, change or withdraw the analytics choice (footer on every page, and the privacy page).
 * A real button, not a link: it performs an action on the page instead of navigating.
 */
export function ConsentSettingsButton({ className, children = "Cookie settings" }: { className?: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-consent-open
      onClick={openConsentSettings}
      className={className ?? "cursor-pointer text-left text-violet-300 underline underline-offset-[3px] hover:text-[#e3d6fb]"}
    >
      {children}
    </button>
  );
}
