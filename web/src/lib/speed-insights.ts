/**
 * Vercel Speed Insights is OFF unless AZERDEX_SPEED_INSIGHTS=1 is set on the deployment.
 *
 * Why opt-in: the free tier only reports a Real Experience Score and shares 10,000 events per rolling 30 days across the
 * whole Vercel team (collection pauses when it is used up). The Core Web Vitals breakdowns (LCP, INP, CLS) need Speed
 * Insights Plus, which is billed per project and per event. Nothing here enables or changes a Vercel plan; the variable
 * only decides whether this site renders the collection script at all. When it is off no script is requested and no
 * measurement is sent. Activation requirements and pricing: docs/web/vercel-speed-insights.md.
 *
 * Read per request on the server (the root layout is dynamic), so it needs no NEXT_PUBLIC_ prefix and no rebuild.
 */
export function speedInsightsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.AZERDEX_SPEED_INSIGHTS === "1";
}
