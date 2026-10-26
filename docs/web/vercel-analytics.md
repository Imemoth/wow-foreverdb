# AzerDex Web Analytics (Vercel)

## Scope

The AzerDex public site uses `@vercel/analytics/next` v2 to measure pageviews
(including client-side App Router navigation). No analytics tables, Supabase
migrations, cookies, custom events, or new environment variables are required.

The root layout mounts `TrafficAnalytics` only on Vercel-hosted requests
whose Host is `azerdex.com`, `www.azerdex.com`, or `beta.azerdex.com`.
`beforeSend` is a second line of defence: it drops other origins, malformed
URLs, `/account/**`, `/auth/**`, `/verify/**`, and `/test-fixtures/**`.
It strips query strings and URL fragments from retained pageviews to prevent
search terms, email addresses, query tokens and other private values from being
transmitted. No user identity or account information is included in custom data.

This deliberately means the Analytics report cannot distinguish visits by
search query or by URL-based UTM tags. Referrer, country, device, browser and
page/route reports remain available where supported by Vercel.

Do **not** relax the site's nonce-based CSP: version 2 dynamically adds a
same-origin analytics script from the trusted Next.js runtime. Check browser
Console/Network after deployment for CSP/script or collection failures.

## Environments and dashboard

The public `beta.azerdex.com` runs as a Vercel **Preview** deployment, even
though it is publicly reachable. It is **not** represented by the Production
filter. In Vercel `wow-foreverdb > Analytics`:

1. Select `Preview` or `All Environments` to see beta visits.
2. Apply `Hostname = beta.azerdex.com` to remove any unrelated hostnames.
3. After the real release, filter `Production` and `Hostname = azerdex.com`
   to assess production; never add raw Preview totals to Production.
4. Compare Visitors, Pageviews, Pages/Routes and Referrers over equivalent
   calendar periods. Pageviews are **not** unique users.

Because the code only enables analytics on the public hostnames, opening a
generated `*.vercel.app` PR preview does not count visits or load the script.

## Acceptance checks (on the real public beta hostname)

After a reviewed PR is merged into `web/azerdex-beta` and its Vercel
deployment is READY and aliased to `beta.azerdex.com`:

1. Open `https://beta.azerdex.com/` in a normal browser without an ad
   blocker; confirm no CSP errors.
2. In DevTools > Network, confirm the analytics script loads and a pageview
   request to a same-origin Vercel intake path ending in `/view` succeeds.
   Version 2 uses a dynamic path; do not hard-code `/_vercel/insights/view`.
3. Navigate client-side to a zone and an item page; confirm one pageview per
   navigation, with no search-query or fragment data.
4. Open `/account` and `/account/dashboard`; confirm no pageview is sent
   for these URLs. Navigate back to a public page and confirm tracking resumes.
5. Verify new beta visits appear in `Analytics > Preview / All Environments`
   with `Hostname = beta.azerdex.com`. Appearance can be delayed.
6. Check that tests/CI, production build, account E2E, and the existing security
   header tests remain green.

This is privacy-oriented **traffic estimation**, not a verified census of
humans: ad blockers, disabled JavaScript and bot traffic can distort counts.
The app does not attempt to identify or fingerprint visitors to compensate.

**Rollout:** merge into `web/azerdex-beta` only after CI/Preview acceptance.
Do not change `main`, `FOREVERDB_DEPLOYMENT`, Vercel protection, or
Supabase. Review the published site's privacy notice before broad release.

## Maintenance

- Privacy filter: `web/src/lib/analytics.ts`.
- Single mount: `web/src/app/layout.tsx` / `web/src/components/TrafficAnalytics.tsx`.
- Tests: `web/tests/unit/analytics.test.ts`.
- Use the Vercel project Analytics page for reports; avoid deploying a parallel
  homemade tracking API or persisting visitor addresses.
