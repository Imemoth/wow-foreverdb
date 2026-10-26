import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { accountRuntime } from "@/lib/account/runtime";
import { callWebRpc } from "@/lib/account/rpc-client";
import { jarFrom, resolveSession } from "@/lib/account/session";
import { AccountDashboard } from "./_ui/AccountDashboard";

export const metadata = { title: "My account" };

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
  const created = r.user.createdAt ? new Date(r.user.createdAt) : null;
  const since = created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
  // The same read-only list the installations page shows; it only feeds the summaries below, so a failure just drops them.
  const inst = await callWebRpc(ac.cfg, "fdb_account_installations", {}, r.session.at);

  return <AccountDashboard email={r.user.email} since={since} installations={inst.ok ? inst.data : null} welcome={welcome === "1"} />;
}
