"use client";

import { Analytics } from "@vercel/analytics/next";
import { filterAnalyticsEvent } from "@/lib/analytics";

/**
 * Vercel Analytics is rendered once for the App Router. Filtering stays in a
 * client component because beforeSend cannot cross the Server/Client boundary.
 */
export function TrafficAnalytics() {
  return <Analytics beforeSend={filterAnalyticsEvent} />;
}
