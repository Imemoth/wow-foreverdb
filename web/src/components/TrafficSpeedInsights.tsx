"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { filterAnalyticsEvent } from "@/lib/analytics";

/**
 * The Next.js adapter reports Web Vitals for App Router navigations.
 * Use the same URL-redaction / private-route policy as Web Analytics.
 * Keep this callback in a client component; never relax the site's CSP.
 */
export function TrafficSpeedInsights() {
  return <SpeedInsights beforeSend={filterAnalyticsEvent} />;
}
