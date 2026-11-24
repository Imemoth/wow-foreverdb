import { AdminLogout } from "../AdminLogout";
import { Badge, Notice, PageHeader, Panel } from "@/components/admin/primitives";
import { adminCtxForPage } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Settings" };

export default async function SettingsPage() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  return (
    <>
      <PageHeader title="Settings" eyebrow="Session & integration" cap="implemented">What this Admin is connected to. Nothing here can be changed from the browser.</PageHeader>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Session">
          <dl className="space-y-2 text-sm"><div><dt className="text-xs uppercase text-mist">Staff user</dt><dd><code data-testid="settings-uid">{r.ctx.uid}</code></dd></div>
            <div><dt className="text-xs uppercase text-mist">Authentication</dt><dd>Verified AAL2 session, re-checked live on every request</dd></div></dl>
          <div className="mt-4"><AdminLogout /></div>
        </Panel>
        <Panel title="Integration">
          <ul className="space-y-2 text-sm">
            <li>Environment: <Badge tone="warning">isolated · local · disposable</Badge></li>
            <li>CMS backend: private editorial schema through narrow, audited database functions only.</li>
            <li>Publication: intents delivered by an out-of-band worker; the website never publishes directly.</li>
            <li>Hosted activation: <Badge>not enabled</Badge> — this build refuses to run Admin outside the local deployment.</li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
