"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { consentedAnalyticsEvent } from "@/lib/analytics";

/**
 * The Next.js adapter reports Web Vitals for App Router navigations. Off by default (AZERDEX_SPEED_INSIGHTS) and, when enabled,
 * loaded only after the same opt-in as Web Analytics (components/consent/ConsentManager), with the same consent re-check,
 * URL-redaction and private-route policy. Keep this callback in a client component; never relax the site's CSP.
 */
export function TrafficSpeedInsights() {
  return <SpeedInsights beforeSend={consentedAnalyticsEvent} />;
}
