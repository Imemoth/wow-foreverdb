# AzerDex – Vercel Speed Insights

Speed Insights is real-user performance monitoring (RUM), complementary to
Vercel Web Analytics. It measures Core Web Vitals such as LCP, INP and CLS
along with FCP/TTFB where available. It does **not** measure unique visitors
and does not replace traffic analytics.

## Scope and privacy

- Uses `@vercel/speed-insights/next@2.0.0` in the root App Router layout.
- Both Vercel metrics scripts mount only for Vercel-hosted requests to
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
