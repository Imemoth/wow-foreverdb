import { ConsentSettingsButton } from "@/components/consent/ConsentSettingsButton";
import { PRIVACY_NOTICE_VERSION } from "@/lib/consent";
import { PRIVACY_CONTACT_EMAIL } from "@/lib/privacy";

/**
 * Body of /about/privacy. Presentational and secret-free so tests can render it.
 *
 * Every statement here is tied to the implementation it describes (see tests/unit/privacy-disclosure.test.ts, which also
 * pins the cookie names and lifetimes to the code): lib/account/session.ts and csrf.ts (account cookies), proxy.ts
 * (fdb_sid), api/v1/challenge/route.ts (fdb_pass), lib/consent.ts and components/consent (the consent choice and the opt-in
 * gate), lib/analytics.ts (Analytics and Speed Insights filter), lib/speed-insights.ts (opt-in flag), database/migrations 0005,
 * 0012, 0014 and 0015 (account, Companion and Guildbook tables) and database/ops (the retention scripts), companion/ (what the
 * Companion sends). Third-party behaviour is attributed to the provider and linked, never restated as our own guarantee. Do not
 * add a claim here that the code or the provider's own documentation does not support, and do not state a retention period that
 * is not enforced. docs/gdpr/ holds the working notes (processor inventory, retention schedule, Companion data-flow audit).
 */
const EXT = { rel: "noopener noreferrer" } as const;

export function PrivacyContent({ speedInsights }: { speedInsights: boolean }) {
  return (
    <div className="prose-fdb">
      <p className="text-sm text-mist">Privacy notice version {PRIVACY_NOTICE_VERSION}.</p>
      <p>
        This page describes what the AzerDex website stores and processes, and why. It covers the public website and the
        optional AzerDex account, and, in a separate section below, the ForeverDB addon and Companion that can be linked to an
        account.
      </p>
      <p>
        Browsing the public pages does not require an account. AzerDex does not show advertising. Some personal data is
        processed: an account stores your email address, and the site uses a small number of cookies, short-lived technical
        counters and, only if you allow it, aggregate traffic analytics, all described below.
      </p>

      <h2 id="controller">Who is responsible</h2>
      <p>
        The data controller is <strong>Hrabovszki P&eacute;ter</strong>, a private individual. AzerDex is an independent, free,
        non-commercial fan project. For anything about your personal data, including exercising the rights described below,
        write to <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>.
      </p>

      <h2 id="when">When information is needed, and when browsing is anonymous</h2>
      <ul>
        <li>
          <strong>Browsing the public database, news and guides:</strong> no account, no sign-in and no information from you is
          needed. Your browser still sends technical data (such as your IP address) to the host to deliver pages, see{" "}
          <a href="#website">The public website</a>.
        </li>
        <li>
          <strong>Creating an account:</strong> an email address and a password are required, because the account cannot exist
          without them. An account is optional and free.
        </li>
        <li>
          <strong>Linking a Companion installation:</strong> requires an account (see <a href="#accounts">Accounts</a> and{" "}
          <a href="#companion">Addon and Companion</a>).
        </li>
        <li>
          <strong>Optional analytics:</strong> never required. Nothing on the site depends on it.
        </li>
      </ul>

      <h2 id="website">The public website</h2>
      <ul>
        <li>
          <strong>Purpose and legal basis:</strong> delivering the pages and keeping the database available and secure
          (fair-use limits, abuse and bot protection). Legitimate interests, Article 6(1)(f) GDPR.
        </li>
        <li>
          <strong>Data:</strong> the IP address and request details your browser sends to the host (Vercel), an anonymous random
          session identifier in a cookie, and short-lived counters described under <a href="#abuse">Abuse protection</a>.
        </li>
        <li>
          <strong>Recipients:</strong> Vercel (hosting). See <a href="#recipients">Services that process data for AzerDex</a>.
        </li>
      </ul>

      <h2 id="accounts">Accounts</h2>
      <p>
        An account is optional. Legal basis: providing the account you ask for, Article 6(1)(b) GDPR. When you register and use it:
      </p>
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
          from our server. On the human-verification page (<code>/verify</code>) your IP address is also passed to Cloudflare for
          that check. Legitimate interests (security), Article 6(1)(f) GDPR.
        </li>
        <li>
          <strong>Companion installations:</strong> if you link an AzerDex Companion installation to your account, the
          installation&apos;s identifier is associated with your account so you can see and manage it. The website lists how
          many installations are connected. Linking events are recorded with the event type, your account identifier, the
          installation identifier and a timestamp. The link itself is kept while the installation stays linked to your
          account. What the Companion itself sends is described in <a href="#companion">Addon and Companion</a>.
        </li>
        <li>
          <strong>Sessions:</strong> signing in sets the account cookies listed below. Signing out removes them.
        </li>
        <li>
          <strong>Retention:</strong> the account is kept until it is deleted. There is no self-service deletion yet: write to{" "}
          <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a> and it is deleted by hand, together with the
          related records described under <a href="#retention">Retention</a>.
        </li>
      </ul>
      <p>
        The sign-up, sign-in, password-recovery and Companion-linking pages link to this notice. Account pages are excluded from
        the analytics described below and do not set the anonymous browsing cookie. No consent box is needed for an account:
        its basis is the service you request, not consent.
      </p>

      <h2 id="cookies">Cookies and browser storage</h2>
      <p>
        These are the only cookies AzerDex sets. All of them are strictly necessary to run or protect the site; none is used
        for advertising or for building a browsing profile, and none depends on the analytics choice.
      </p>
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
        <li>
          <code>__Secure-fdb_reset</code>: set only while a password reset is being completed. It lets the same browser finish
          an incomplete reset. It is encrypted, HTTP-only, secure, sent only to <code>/account</code> pages, and expires
          after 1 hour.
        </li>
      </ul>
      <h3>Browser storage</h3>
      <p>
        <code>azerdex-consent</code> (local storage): remembers your analytics choice, the date you made it and the version of this
        notice it was made under, so you are not asked again on every visit. It stays in your browser and is not sent to AzerDex or
        anyone else. It holds no identifier. Choosing again from the footer replaces it.
      </p>
      <p>
        The homepage background theme is chosen at random and remembered for the current tab in your browser&apos;s session
        storage (<code>azerdex-hero-theme</code>). It stays in your browser, is removed when the tab closes, and is not sent to
        AzerDex.
      </p>
      <p>
        Cloudflare Turnstile, where it appears, is operated by Cloudflare and is governed by{" "}
        <a href="https://www.cloudflare.com/privacypolicy/" {...EXT}>Cloudflare&apos;s own privacy terms</a>.
      </p>

      <h2 id="analytics">Traffic analytics (optional, only with your consent)</h2>
      <p>
        The site can use <strong>Vercel Web Analytics</strong> to count visits to public pages. It is <strong>off until you
        choose &ldquo;Accept analytics&rdquo;</strong>: before that, and after you refuse or withdraw, no analytics script is
        loaded and nothing is sent to Vercel for measurement. Legal basis: your consent, Article 6(1)(a) GDPR; you can withdraw it
        at any time with the same ease: <ConsentSettingsButton>change your choice</ConsentSettingsButton> (also in the footer of
        every page). Withdrawing does not affect earlier processing, and it does not sign you out. What AzerDex controls:
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
          <strong>Vercel Speed Insights</strong> is enabled and measures page-load performance (web vitals). It is optional in the
          same way: it loads only after you accept analytics. It follows the same
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
        AzerDex is hosted on Vercel, which, like any web host, processes request data such as IP addresses to deliver pages, whether
        or not you accept analytics. See{" "}
        <a href="https://vercel.com/legal/privacy-policy" {...EXT}>Vercel&apos;s privacy policy</a>.
      </p>

      <h2 id="abuse">Abuse protection</h2>
      <p>
        To keep the database available, request counters are kept per network address and per session for a few minutes.
        Addresses are stored only as keyed hashes in those short-lived counters, and the address itself is not written to our logs.
        A shortened form (the first 8 characters) of the keyed hash can appear in an operational log line when a request is
        rate limited. The random session identifier from the anonymous browsing cookie is also part of a counter key. Account
        sign-up, sign-in and recovery requests are also limited per address and per email address, using keyed hashes in
        short-lived counters. The counters are held in memory or, when configured, in Upstash Redis. Legitimate interests,
        Article 6(1)(f) GDPR.
      </p>

      <h2 id="companion">Addon and Companion (separate software)</h2>
      <p>
        The ForeverDB addon runs inside World of Warcraft and the ForeverDB Companion is a Windows application on your computer.
        They are separate from this website. They are optional, and what follows is what they actually do in the current
        source code. Legal basis for the processing AzerDex does with what they send: providing the service you set them up for,
        Article 6(1)(b) GDPR. The Guildbook is not processed by AzerDex: it stays on your computer (see below).
      </p>
      <h3>What the addon records on your computer</h3>
      <ul>
        <li>
          A random installation identifier, generated on your computer, and observed loot, gathering and location statistics
          (item and source identifiers and counts, map positions rounded to a coarse grid).
        </li>
        <li>
          A <strong>Guildbook</strong>: for your guild, its name and realm, and for each member the character name, class, level,
          rank, online state, zone, how long ago they were last online and their professions, plus your own character&apos;s
          professions. Officer notes are not collected. The Guildbook is kept on your computer only: it is never uploaded.
        </li>
        <li>
          A <strong>session tracker</strong> (your character name and realm, gold and experience accounting, recent session
          history). The session tracker is local-only: it is never part of the export the Companion reads.
        </li>
      </ul>
      <h3>What the Companion sends</h3>
      <ul>
        <li>
          The Companion reads the addon&apos;s export and uploads <strong>public observations only</strong> to AzerDex&apos;s
          private Supabase backend (the same Supabase service as accounts): the installation identifier, versions, the
          observation statistics (sources, items, quantities and coarse-grid locations) and map metadata.
        </li>
        <li>
          <strong>The Guildbook is never uploaded.</strong> No guild name or roster, member character name or identifier,
          profession, rank, online activity or capture detail is sent, whether you use it anonymously, with an account or on a
          registered computer. The Companion builds the upload from an explicit list of observation fields and checks every
          request against that list before it is sent; anything else is refused and nothing is sent.
        </li>
        <li>
          To upload, the Companion signs in to Supabase Auth either with an anonymous identity created for the installation or,
          when you linked it, with your account. Supabase therefore sees your IP address and the identifiers involved. The
          Companion stores its sign-in session and device credential on your computer in Windows-protected storage.
        </li>
        <li>
          When you connect a computer to your account from the Companion, the computer&apos;s Windows name is sent and stored as
          the label of the registered device, so you can recognise it in your account. A device credential is stored as a hash.
        </li>
        <li>
          Map diagnostics: when you are signed in, the Companion can report the status of map-asset preparation (Companion
          version, map and WoW build identifiers, the WoW installation folder name and similar technical details) tied to your
          account identifier.
        </li>
        <li>
          Requests the Companion makes from your computer to other services: <code>wago.tools</code> (public WoW build data,
          so that service sees your IP address) and, when it prepares map images from your game files, it may read them through
          Blizzard&apos;s content network. See their own privacy terms.
        </li>
        <li>
          The Companion has no analytics, telemetry, crash reporter or update-check of its own, and sets no cookies.
        </li>
      </ul>
      <h3>What stays on your computer, and what the website shows</h3>
      <p>
        The Companion stores the Guildbook only on your computer, under <code>%LOCALAPPDATA%\ForeverDB\guildbook\</code>,
        separated by account and installation and protected with Windows encryption for your Windows user (DPAPI). It is shown in
        the Companion only while a verified ForeverDB account is signed in; signing out hides it and keeps the files, and a
        different account cannot read them. You can delete those files yourself at any time. The addon&apos;s own SavedVariables
        file in your WoW folder still contains the raw export and is not encrypted by the Companion. The hosted AzerDex website
        does not display, serve or link the Guildbook, and has no way to read one.
      </p>
      <h3>Historical Guildbook data from earlier versions</h3>
      <p>
        Earlier Companion versions uploaded the Guildbook to the private backend, and records uploaded then may still exist there,
        including character names of guild members. They are private, are not published, cannot be read through this website, and
        are not changed by current Companion versions. <strong>They have not yet been deleted</strong>; removing them is pending and
        this notice will say when that has been done and checked. Until then you can ask for them to be deleted by writing to{" "}
        <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>.
      </p>
      <h3>What is published</h3>
      <p>
        Published database statistics are aggregates. The public database pages read only from that published aggregate
        read model: the website does not receive installation identifiers, character names, Guildbook rosters or account
        information through it. Observation figures are sanitised before publication. With few contributors a published figure
        may rest on observations from very few installations, although no contributor is identified.
      </p>

      <h2 id="retention">Retention</h2>
      <p>
        AzerDex does not set a retention period that it does not enforce. What is deleted automatically, what is deleted by a
        maintenance script that is run by hand, and what is kept until deleted on request:
      </p>
      <ul>
        <li>
          <strong>Account:</strong> kept until deleted on request.
        </li>
        <li>
          <strong>Link between an installation and an account:</strong> kept while the installation stays linked to the account.
        </li>
        <li>
          <strong>Installation statistics (private):</strong> replaced by each upload and kept while the installation exists. There
          is no automatic removal of installations that stop uploading; they are removed on request.
        </li>
        <li>
          <strong>Historical Guildbook records uploaded by earlier Companion versions (private):</strong> kept until they are
          removed; the removal is pending and has not been done. Current versions upload no Guildbook data.
        </li>
        <li>
          <strong>Welcome-email queue:</strong> unverified candidate records and handled failure markers are removed after 30
          days by a scheduled daily job; the queue row of a verified account is removed when the account is deleted.
        </li>
        <li>
          <strong>Linking claims, linking audit rows and enrollment tickets:</strong> the rule is that revoked or never-redeemed expired
          claims are deleted after 7 days, linking audit rows after 180 days, and finished enrollment tickets after 90 days. This is
          applied by a maintenance script that is run by hand and is not yet scheduled, so these rows can remain longer until it runs.
        </li>
        <li>
          <strong>Registered-device records and their audit trail, and Companion map diagnostics:</strong> kept; there is no automatic
          deletion yet.
        </li>
        <li>
          <strong>Short-lived counters:</strong> a few minutes for request counters. Per-account usage counters (for example for
          linking attempts) are meant to expire after 24 hours; their clean-up is a maintenance script that is run by hand.
        </li>
        <li>
          <strong>Cookies:</strong> lifetimes are listed above.
        </li>
        <li>
          <strong>Requests to {PRIVACY_CONTACT_EMAIL}:</strong> kept as long as needed to answer the request and to document how it
          was handled.
        </li>
        <li>
          <strong>Data held by services we use</strong> (hosting and delivery logs, analytics, emails sent, authentication records,
          backups) follows each provider&apos;s own retention; see their linked documentation.
        </li>
      </ul>

      <h2 id="recipients">Services that process data for AzerDex</h2>
      <p>
        AzerDex does not sell personal data. These services process it on AzerDex&apos;s behalf under the providers&apos;
        data-processing terms. The data they hold is covered by the retention above and by their own terms.
      </p>
      <ul>
        <li>
          <strong>Vercel</strong> (hosting, and optional traffic analytics): request data such as IP addresses to deliver pages.
        </li>
        <li>
          <strong>Supabase</strong> (authentication, and the databases behind accounts, the Companion and published data): your
          email, account records and the Companion data described above. The Supabase projects are hosted in the EU (Ireland).
        </li>
        <li>
          <strong>Resend</strong> (email delivery, and the inbox for {PRIVACY_CONTACT_EMAIL}): recipient addresses and message
          content of account emails, and the messages you send us. Resend stores this data in the United States.
        </li>
        <li>
          <strong>Cloudflare</strong> (Turnstile bot protection; also its network may serve map and image files when that option
          is enabled): the Turnstile verification data and, for served files, ordinary request data such as IP address.
        </li>
        <li>
          <strong>Upstash</strong> (short-lived rate-limit counters, when that backend is configured): keyed hashes and a random
          session identifier, no email address.
        </li>
        <li>
          Plain links only, loading nothing until you follow them: a voluntary support link to an external service (Buy Me a
          Coffee), and links to GitHub. Their own terms then apply.
        </li>
      </ul>

      <h2 id="transfers">International transfers</h2>
      <p>
        Vercel, Cloudflare, Resend, Upstash and Supabase are US companies or operate global infrastructure, so personal data can be
        processed outside the European Economic Area. These transfers rely on the safeguards in each provider&apos;s data-processing
        agreement, which include the European Commission&apos;s Standard Contractual Clauses where applicable, and on the
        providers&apos; own transfer documentation. Resend stores the email data it handles in the United States. You can ask for a
        copy of the safeguards at {PRIVACY_CONTACT_EMAIL}.
      </p>
      <p>
        See: <a href="https://vercel.com/legal/dpa" {...EXT}>Vercel DPA</a>,{" "}
        <a href="https://supabase.com/legal/dpa" {...EXT}>Supabase DPA</a>,{" "}
        <a href="https://resend.com/legal/dpa" {...EXT}>Resend DPA</a>,{" "}
        <a href="https://www.cloudflare.com/cloudflare-customer-dpa/" {...EXT}>Cloudflare DPA</a>.
      </p>

      <h2 id="rights">Your rights</h2>
      <p>
        Under the GDPR you have the right to access your personal data, to have it corrected, to have it erased, to restrict or object
        to its processing, to receive the data you provided in a portable format, and to withdraw consent at any time. The processing
        described here involves no automated decision-making and no profiling.
      </p>
      <ul>
        <li>
          <strong>How:</strong> email <a href={`mailto:${PRIVACY_CONTACT_EMAIL}`}>{PRIVACY_CONTACT_EMAIL}</a>. Say which right you want to
          use and, for an account or an installation, from which email address or installation identifier. Requests are handled by
          a person, not by automated processing.
        </li>
        <li>
          <strong>Identity:</strong> to avoid giving your data to someone else, a request about an account is checked proportionately, for
          example by replying from the account&apos;s email address. Nothing more than needed is asked.
        </li>
        <li>
          <strong>When:</strong> you get a response within one month of the request. If a request is complex or numerous this can be
          extended by up to two further months, and you are told why within the first month. It is free of charge unless a request is
          manifestly unfounded or excessive.
        </li>
        <li>
          <strong>Analytics consent:</strong> withdraw it yourself at any time via the footer link <em>Cookie settings</em>.
        </li>
      </ul>
      <p>
        If you are not satisfied you can complain to the supervisory authority. In Hungary this is the{" "}
        <a href="https://www.naih.hu/" {...EXT}>Hungarian National Authority for Data Protection and Freedom of Information
        (Nemzeti Adatv&eacute;delmi &eacute;s Inform&aacute;ci&oacute;szabads&aacute;g Hat&oacute;s&aacute;g, NAIH)</a>; you may also
        complain to the authority in the EU country where you live or work.
      </p>
    </div>
  );
}
