/**
 * Body of /about/privacy. Presentational and secret-free so tests can render it.
 *
 * Every statement here is tied to the implementation it describes (see tests/unit/privacy-disclosure.test.ts, which also
 * pins the cookie names and lifetimes to the code): lib/account/session.ts and csrf.ts (account cookies), proxy.ts
 * (fdb_sid), api/v1/challenge/route.ts (fdb_pass), lib/analytics.ts (Analytics and Speed Insights filter),
 * lib/speed-insights.ts (opt-in flag) and database/migrations/0012 and 0015 (account tables). Third-party behaviour is
 * attributed to the provider and linked, never restated as our own guarantee. Do not add a claim here that the code or the
 * provider's own documentation does not support.
 */
const EXT = { rel: "noopener noreferrer" } as const;

export function PrivacyContent({ speedInsights }: { speedInsights: boolean }) {
  return (
    <div className="prose-fdb">
      <p>
        This page describes what the AzerDex website stores and processes, and why. It covers the public website and the
        optional AzerDex account. The ForeverDB addon and Companion are separate software and are not covered here.
      </p>
      <p>
        Browsing the public pages does not require an account. AzerDex does not show advertising. Some personal data is
        processed: an account stores your email address, and the site uses a small number of cookies, aggregate traffic
        analytics and short-lived technical counters, all described below.
      </p>

      <h2>Accounts</h2>
      <p>An account is optional. When you register and use it:</p>
      <ul>
        <li>
          <strong>What you provide:</strong> your email address and a password. They are passed to the authentication service
          (Supabase Auth) that holds the account. The website shows you your email address and when your account was created.
        </li>
        <li>
          <strong>Email:</strong> confirmation, password-reset and welcome messages are sent to your address through the
          email provider Resend. The queue that decides who receives the welcome message stores a one-way SHA-256 hash of your
          address, not the address itself.
        </li>
        <li>
          <strong>Bot protection:</strong> registration, resending a confirmation and password recovery use Cloudflare
          Turnstile. The Turnstile script is loaded from Cloudflare on those pages and the result is verified with Cloudflare
          from our server.
        </li>
        <li>
          <strong>Companion installations:</strong> if you link an AzerDex Companion installation to your account, the
          installation&apos;s identifier is associated with your account so you can see and manage it. The website lists how
          many installations are connected. Linking events are recorded with the event type, your account identifier, the
          installation identifier and a timestamp. The link itself is kept while the installation stays linked to your
          account. Retention rule for the supporting records, applied by a maintenance script: revoked or never-redeemed
          expired claims are deleted after 7 days and audit rows after 180 days.
        </li>
        <li>
          <strong>Sessions:</strong> signing in sets the account cookies listed below. Signing out removes them.
        </li>
      </ul>
      <p>
        Account pages are excluded from the analytics described below and do not set the anonymous browsing cookie.
      </p>

      <h2>Cookies and browser storage</h2>
      <p>These are the only cookies AzerDex sets. None is used for advertising or for building a browsing profile.</p>
      <h3>Public browsing</h3>
      <ul>
        <li>
          <code>__Host-fdb_sid</code> (named <code>fdb_sid</code> on a plain-HTTP development server): a random identifier used only to apply
          fair-use rate limits. It is not linked to any personal data, is HTTP-only, and expires after 30 days.
        </li>
        <li>
          <code>fdb_pass</code>: set only if you complete a human-verification challenge (Cloudflare Turnstile); it is HTTP-only and
          expires after 30 minutes.
        </li>
      </ul>
      <h3>Account (only when you use an account)</h3>
      <ul>
        <li>
          <code>__Secure-fdb_acct</code> (and numbered continuation cookies if it grows large): your sign-in session. It is
          encrypted, HTTP-only, secure, sent only to <code>/account</code> pages, and lasts up to 14 days of activity and never
          more than 30 days in total. A password-recovery session lasts 15 minutes.
        </li>
        <li>
          <code>__Secure-fdb_csrf</code>: an anti-forgery token for account forms. It is HTTP-only, sent only to{" "}
          <code>/account</code> pages, and expires after 1 hour.
        </li>
      </ul>
      <h3>Browser storage</h3>
      <p>
        The homepage background theme is chosen at random and remembered for the current tab in your browser&apos;s session
        storage (<code>azerdex-hero-theme</code>). It stays in your browser, is removed when the tab closes, and is not sent to
        AzerDex.
      </p>
      <p>
        Cloudflare Turnstile, where it appears, is operated by Cloudflare and is governed by{" "}
        <a href="https://www.cloudflare.com/privacypolicy/" {...EXT}>Cloudflare&apos;s own privacy terms</a>.
      </p>

      <h2>Traffic analytics</h2>
      <p>
        The site uses <strong>Vercel Web Analytics</strong> to count visits to public pages. What AzerDex controls:
      </p>
      <ul>
        <li>It runs only on the public AzerDex hosts, not on generated preview URLs or local development.</li>
        <li>
          Account, sign-in, verification and test pages are excluded: no measurement is sent for them.
        </li>
        <li>
          The query string and the fragment are removed from the address in your browser before anything is sent, so search
          terms and tokens in a URL are not transmitted.
        </li>
      </ul>
      <p>
        What Vercel processes is described by Vercel. According to its documentation, Web Analytics does not use third-party
        cookies, identifies a visitor by a hash created from the request and discards that visitor session after 24 hours,
        and stores data points such as the time, the page path, the referrer, an approximate location, the browser, the
        operating system and the device type. See{" "}
        <a href="https://vercel.com/docs/analytics/privacy-policy" {...EXT}>Vercel Web Analytics privacy and compliance</a>.
      </p>
      {speedInsights ? (
        <p>
          <strong>Vercel Speed Insights</strong> is enabled and measures page-load performance (web vitals). It follows the same
          rules as above: public AzerDex hosts only, account, sign-in and verification pages excluded, and query strings and
          fragments removed before sending. According to Vercel, its data points are anonymous, are not tied to an individual
          visitor or IP address, and include the route, the page path, connection speed, browser, device type and operating
          system, the country, the measured value and the page element it relates to. See{" "}
          <a href="https://vercel.com/docs/speed-insights/privacy-policy" {...EXT}>Vercel Speed Insights privacy and compliance</a>.
        </p>
      ) : (
        <p>Vercel Speed Insights performance measurement is not enabled on this site.</p>
      )}
      <p>
        AzerDex is hosted on Vercel, which, like any web host, processes request data such as IP addresses to deliver pages. See{" "}
        <a href="https://vercel.com/legal/privacy-policy" {...EXT}>Vercel&apos;s privacy policy</a>.
      </p>

      <h2>Abuse protection</h2>
      <p>
        To keep the database available, request counters are kept per network address and per session for a few minutes.
        Addresses are stored only as keyed hashes in those short-lived counters, and are not written to our logs. Account
        sign-up, sign-in and recovery requests are also limited per address and per email address, using keyed hashes in
        short-lived counters.
      </p>

      <h2>Game data</h2>
      <p>
        Published database statistics are aggregates. The public database pages read only from that published aggregate
        read model: the website does not receive installation identifiers, character names, Guildbook rosters or account
        information through it. Account pages are a separate, signed-in area.
      </p>

      <h2>Other services</h2>
      <ul>
        <li>Vercel: hosting and traffic analytics.</li>
        <li>Supabase: the authentication service and database behind accounts and published data.</li>
        <li>Resend: delivery of account emails.</li>
        <li>Cloudflare: Turnstile bot protection.</li>
        <li>
          The header contains a voluntary support link to an external service (Buy Me a Coffee). It is a plain link: nothing is
          loaded from that service unless you follow it, and its own terms then apply.
        </li>
      </ul>
    </div>
  );
}
