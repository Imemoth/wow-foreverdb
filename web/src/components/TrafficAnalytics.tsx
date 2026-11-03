"use client";

import { Analytics } from "@vercel/analytics/next";
import { consentedAnalyticsEvent } from "@/lib/analytics";

/**
 * Vercel Analytics is rendered once for the App Router, and ONLY by components/consent/ConsentManager after the visitor has
 * opted in. Filtering stays in a client component because beforeSend cannot cross the Server/Client boundary; it re-checks consent
 * for every event and applies the public-host / private-route / URL-redaction policy.
 */
export function TrafficAnalytics() {
  return <Analytics beforeSend={consentedAnalyticsEvent} />;
}
