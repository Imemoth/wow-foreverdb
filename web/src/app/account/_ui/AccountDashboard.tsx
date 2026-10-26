import Link from "next/link";
import { ArrowRightIcon, BookIcon, CheckIcon, CircleUserIcon, InstallIcon, MonitorIcon } from "../_components/icons";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const CARD = "panel flex flex-col gap-3 p-5";
const CARD_TITLE = "flex items-center gap-2.5 font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide text-gold-300";

/** The /account dashboard. Purely presentational: `installations` is null when the list could not be read (summaries are then generic). */
export function AccountDashboard({ email, since, installations, welcome }: {
  email: string;
  since: string | null;
  installations: { guild_count: number }[] | null;
  welcome: boolean;
}) {
  const guilds = installations?.reduce((n, i) => n + i.guild_count, 0) ?? 0;
  return (
    <div data-account-wide className="space-y-4">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">My Account</h1>
        <p className="mt-1 text-sm text-mist">Manage your AzerDex account and connected installations.</p>
      </div>
      {welcome && (
        <p role="status" className="rounded-lg border border-conf-high/40 bg-conf-high/10 px-3 py-2 text-sm text-conf-high">
          Your email address is confirmed. Welcome to AzerDex.
        </p>
      )}

      <section className={CARD} aria-labelledby="profile-h">
        <div className="flex items-center justify-between gap-3">
          <h2 id="profile-h" className={CARD_TITLE}><CircleUserIcon className="h-5 w-5" />Profile</h2>
          <span className="inline-flex items-center gap-1 rounded-full border border-conf-high/40 bg-conf-high/10 px-2.5 py-0.5 text-xs font-semibold text-conf-high">
            <CheckIcon className="h-3 w-3" />Verified
          </span>
        </div>
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <dt className="text-mist">Email address</dt>
            <dd className="mt-0.5 break-all font-medium text-parchment">{email}</dd>
          </div>
          {since && (
            <div className="sm:text-right">
              <dt className="text-mist">Member since</dt>
              <dd className="mt-0.5 font-medium text-parchment">{since}</dd>
            </div>
          )}
        </dl>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className={CARD} aria-labelledby="inst-h">
          <h2 id="inst-h" className={CARD_TITLE}><InstallIcon className="h-5 w-5" />Companion installations</h2>
          <p className="text-sm text-mist">
            {installations && installations.length > 0
              ? `${plural(installations.length, "installation", "installations")} connected to your account.`
              : "Connect the Companion app to sync your characters and guilds with AzerDex."}
          </p>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <Link href="/account/link" className="btn-primary">Connect Companion</Link>
            <Link href="/account/installations" className="btn-ghost">My installations</Link>
          </div>
        </section>

        <section className={CARD} aria-labelledby="dev-h">
          <h2 id="dev-h" className={CARD_TITLE}><MonitorIcon className="h-5 w-5" />My Devices</h2>
          <p className="text-sm text-mist">View your registered computers and manage their activation files.</p>
          <div className="mt-auto pt-1">
            <Link href="/account/devices" className="btn-ghost">Manage devices</Link>
          </div>
        </section>
      </div>

      <Link href="/account/guildbook" className="panel group flex items-center gap-4 p-5 no-underline transition hover:border-violet-400">
        <BookIcon className="h-6 w-6 shrink-0 text-gold-400" />
        <span className="min-w-0 flex-1">
          <span className="block font-[family-name:var(--font-display)] text-lg font-semibold tracking-wide text-gold-300">Private Guildbook</span>
          <span className="mt-0.5 block text-sm text-mist">
            {installations && installations.length === 0
              ? "Nothing here yet. Connect a Companion and your characters and guilds will show up in your Guildbook."
              : installations && guilds > 0
                ? `${plural(guilds, "guild", "guilds")} synchronized from your characters. Explore your private guild data.`
                : "Explore your synchronized characters and guild data."}
          </span>
        </span>
        <ArrowRightIcon className="h-5 w-5 shrink-0 text-violet-300 transition group-hover:translate-x-0.5" />
      </Link>
    </div>
  );
}
