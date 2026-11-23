import { notFound } from "next/navigation";
import { AdminShell, EnvBanner } from "@/components/admin/Shell";
import { adminRuntime } from "@/lib/admin/runtime";
import { adminCtxForPage } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";

/**
 * The real Admin shell. Disabled (404) everywhere except an explicitly local, disposable runtime (adminEnabled in lib/admin/runtime.ts).
 * The layout only decides whether to show the shell: every page and every action verifies the live session again.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const rt = adminRuntime();
  if (rt.state === "disabled") notFound();
  if (rt.state === "unavailable") return <div className="mx-auto max-w-xl p-8"><h1 className="panel-title text-2xl">Admin temporarily unavailable</h1></div>;
  const r = await adminCtxForPage();
  if (!r.ok) {
    return (
      <div className="flex min-h-screen flex-col">
        <EnvBanner />
        <main id="admin-main" className="mx-auto w-full max-w-xl flex-1 px-4 py-10">
          <h1 className="panel-title text-2xl">Admin access unavailable</h1>
          <p className="mt-3 text-parchment/90" data-testid="admin-denied">Complete a fresh TOTP verification from your account to enter Admin. Staff access, an active policy and a TOTP verification from the last 15 minutes are all required.</p>
          <p className="mt-4"><a className="btn-primary" href="/account">My account</a></p>
        </main>
      </div>
    );
  }
  return <AdminShell uid={r.ctx.uid}>{children}</AdminShell>;
}
