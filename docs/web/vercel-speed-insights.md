# AzerDex – Vercel Speed Insights

Speed Insights is real-user performance monitoring (RUM), complementary to
Vercel Web Analytics. It measures Core Web Vitals such as LCP, INP and CLS
along with FCP/TTFB where available. It does **not** measure unique visitors
and does not replace traffic analytics.

## Status: OFF by default (opt-in, cost-controlled)

The site renders the Speed Insights script **only when `AZERDEX_SPEED_INSIGHTS=1`** is set on the deployment
(`web/src/lib/speed-insights.ts`, read per request by the root layout; no rebuild and no `NEXT_PUBLIC_` prefix). With the
variable unset (the default on production, preview and local), the browser never requests the Speed Insights script or its
intake endpoint. Vercel Web Analytics is unaffected and stays on for the public hosts. Setting or removing the variable
changes nothing in the Vercel plan or billing by itself.

### What activation requires, and what it costs

Source: Vercel, "Limits and Pricing for Speed Insights" (https://vercel.com/docs/speed-insights/limits-and-pricing, page last
updated 2026-09-23). Re-check before relying on figures; Vercel changes pricing.

| | Speed Insights (free tier) | Speed Insights Plus |
|---|---|---|
| Plans | Hobby, Pro, Enterprise | Pro and Enterprise only (a Hobby team must upgrade to Pro first) |
| Price | no project fee, no event charge | $10 per project per month on Pro, plus events at $0.65 per 10,000 (no included events on Pro) |
| Events | 10,000 over a rolling 30 days, shared by the whole team; collection pauses for at least 14 days when exhausted | billed on demand |
| Metrics | Real Experience Score only; path/route counts with Great / Needs Improvement entries | all Core Web Vitals (FCP, LCP, INP, CLS, TTFB), all breakdowns, 30-day range, Drains |

So: `AZERDEX_SPEED_INSIGHTS=1` alone can only ever use whatever Speed Insights tier the Vercel project already has. The LCP / INP /
CLS review in "Deploy and acceptance" below needs **Plus**, which is a paid feature and needs the owner's explicit approval; the
free tier gives only the Real Experience Score. At the time of this change the Vercel project already serves the Speed Insights
script route on `azerdex.com` and `beta.azerdex.com` (HTTP 200 on `/_vercel/speed-insights/script.js`), i.e. the project toggle is on,
but whether the project is on the free tier or Plus could not be read with the access available. Check
Vercel > project > Speed Insights, and Team > Usage / Billing, before activating.

To activate (owner action, after reviewing the above): set `AZERDEX_SPEED_INSIGHTS=1` for the **Production** environment in the
Vercel project settings and redeploy/promote; choose Plus only if the paid metrics are wanted. To deactivate: remove the variable.
The privacy page text follows the same switch (`/about/privacy` says Speed Insights is enabled only when this is set).

## Scope and privacy

- Uses `@vercel/speed-insights/next@2.0.0` in the root App Router layout, behind the opt-in switch above.
- When enabled, both Vercel metrics scripts mount only for Vercel-hosted requests to
  `azerdex.com`, `www.azerdex.com`, or `beta.azerdex.com`.
  Localhost and generated `*.vercel.app` PR previews do not load them.
- The Speed Insights `beforeSend` callback reuses
  `filterAnalyticsEvent` in `web/src/lib/analytics.ts`. It blocks
  `/account/**`, `/auth/**`, `/verify/**` and `/test-fixtures/**`,
  denies untrusted or HTTP hosts, and removes query strings and fragments
  before metrics are transmitted. No account identity or tokens are included.
- Keep strict CSP (`script-src` nonce + `strict-dynamic`, no
  `unsafe-eval`), same-origin intake and existing authentication boundaries.
  No cookies, Supabase schema, environment variables or bespoke tracking API
  are needed for this integration.

## Deploy and acceptance

1. **Enable Speed Insights in the Vercel project dashboard** if the toggle has
   not already been switched on. Installing the package does **not** enable
   the project service; Vercel must configure collection routes.
2. Merge the reviewed PR into `web/azerdex-beta` only after the full GitHub
   release gate and Vercel Preview build pass. Do not touch `main`.
3. Verify the resulting Vercel deployment is READY and aliased to
   `beta.azerdex.com`.
4. On a real, unblocked browser at `https://beta.azerdex.com/`, open
   DevTools > Network. Confirm a same-origin Speed Insights script loads,
   then observe a successful same-origin metrics intake request. V2 can use
   dynamically discovered paths, so don't assume a fixed endpoint.
5. Visit a zone, item and database page, including one with a search query,
   then verify no query data is sent. Check CSP console for errors.
6. Verify `/account` and `/auth` performance data is **not** transmitted
   (ideally test in a fresh browser with no other pending metrics).
7. In the [Speed Insights dashboard](https://vercel.com/imemoths-projects/wow-foreverdb/speed-insights),
   choose Preview / All Environments and `beta.azerdex.com` where the
   filter is available. Allow for processing delay; do not confuse PREVIEW
   with PRODUCTION.
8. Review LCP, INP, CLS and route/path breakdowns across desktop/mobile and
   comparable time windows. Confirm sample volume and the Vercel plan's
   included event limits before increasing sampling.

## Limits

Performance data arrives only after real browsers generate Web Vitals;
successful builds alone do **not** prove metrics collection. Browsers with
blockers, no JS, or inactive pages may contribute no data. `beforeSend`
filters URL data, but the site privacy notice should still describe RUM
collection. This is intentionally not a synthetic Lighthouse test or a
session-level visitor tracking system.

See `docs/web/vercel-analytics.md` for the complementary visitor dashboard.
