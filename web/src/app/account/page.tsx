import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, resolveSession } from "@/lib/account/session";
import { LogoutButton } from "./_components/LogoutButton";

export const metadata = { title: "Overview" };

export default async function AccountOverview({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const rt = accountRuntime();
  if (rt.state !== "ready") return null; // the layout already rendered the disabled / unavailable state
  const ac = rt.ctx;
  const store = await cookies();
  const r = await resolveSession(ac.cfg, jarFrom(() => store.getAll()), ac.https, { kind: "user", canWrite: false });

  if (r.state === "anonymous") redirect("/account/login?next=%2Faccount");
  // Pages cannot set cookies: the refresh handler can (it rotates the refresh token, or clears a dead session).
  if (r.state === "needs_refresh" || r.state === "ended") redirect("/account/api/session/refresh?next=%2Faccount");
  if (r.state === "unavailable") {
    return (
      <div className="panel space-y-2 p-6" role="alert">
        <h1 className="panel-title text-2xl">Temporarily unavailable</h1>
        <p className="text-mist">We could not reach the sign-in service. You are still signed in; reload in a moment.</p>
      </div>
    );
  }

  const { welcome } = await searchParams;
  const since = r.user.createdAt ? new Date(r.user.createdAt).toISOString().slice(0, 10) : null;
  return (
    <>
      <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300">Your account</h1>
      {welcome === "1" && (
        <p role="status" className="rounded-lg border border-conf-high/40 bg-conf-high/10 px-3 py-2 text-sm text-conf-high">
          Your email address is confirmed. Welcome to ForeverDB.
        </p>
      )}
      <section className="panel space-y-3 p-6" aria-labelledby="profile-h">
        <h2 id="profile-h" className="panel-title text-lg">Profile</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-mist">Email</dt>
          <dd className="break-all text-parchment">{r.user.email}</dd>
          <dt className="text-mist">Status</dt>
          <dd className="text-parchment">Email confirmed</dd>
          {since && (<><dt className="text-mist">Member since</dt><dd className="text-parchment">{since}</dd></>)}
        </dl>
      </section>
      <section className="panel space-y-3 p-6" aria-labelledby="inst-h">
        <h2 id="inst-h" className="panel-title text-lg">Companion installations</h2>
        <p className="text-sm text-mist">
          Link a Companion installation to this account with a code from the Companion&apos;s ACCOUNT tab, see the installations
          you own, and browse their private Guildbook.
        </p>
        <ul className="space-y-1 text-sm">
          <li><Link href="/account/link">Link an installation</Link></li>
          <li><Link href="/account/installations">Your installations</Link></li>
          <li><Link href="/account/guildbook">Private Guildbook</Link></li>
        </ul>
      </section>
      <LogoutButton />
    </>
  );
}
