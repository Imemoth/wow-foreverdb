import Link from "next/link";
import { Failure } from "@/components/admin/Failure";
import { ADMIN_BASE } from "@/components/admin/Shell";
import { Badge, BTN_PRIMARY, EmptyState, Notice, PageHeader, Panel, TableWrap } from "@/components/admin/primitives";
import { fmtTs, statusOf } from "@/components/admin/status";
import { adminCtxForPage, loadArticles, loadAudit, loadContext } from "@/lib/admin/cms/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin · Dashboard" };

export default async function AdminDashboard() {
  const r = await adminCtxForPage();
  if (!r.ok) return <Notice tone="warning" title="Admin access unavailable">Complete a fresh TOTP verification from your account.</Notice>;
  const c = r.ctx;
  const [ctx, list] = await Promise.all([loadContext(c), loadArticles(c)]);
  if (!ctx.ok) return <Failure f={ctx} what="open the CMS" />;
  const audit = ctx.data.can_read_audit ? await loadAudit(c, 8) : null;
  const items = list.ok ? list.data : [];
  const rows = items.map((a) => ({ a, s: statusOf(a, a.latest_intent) }));
  const count = (k: string): number => rows.filter((x) => x.s.key === k).length;
  const tiles: { k: string; label: string; href: string }[] = [
    { k: "draft", label: "Drafts", href: "draft" }, { k: "in_review", label: "In review", href: "in_review" }, { k: "approved", label: "Approved", href: "approved" },
    { k: "pending", label: "Delivery pending", href: "pending" }, { k: "published", label: "Published", href: "published" }, { k: "failed", label: "Delivery failed", href: "failed" },
  ];
  return (
    <>
      <PageHeader title="Dashboard" eyebrow="AzerDex Admin" cap="implemented">Live counts from the real CMS database, limited to the articles your role may read. Nothing here is simulated.</PageHeader>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="dash-tiles">
        {tiles.map((t) => (
          <Link key={t.k} href={`${ADMIN_BASE}/articles?status=${t.href}`} className="panel block p-4 no-underline hover:border-gold-400/60" data-testid={`tile-${t.k}`}>
            <p className="text-3xl font-semibold text-gold-300" data-testid={`tile-${t.k}-count`}>{count(t.k)}</p><p className="text-sm text-parchment">{t.label}</p>
          </Link>
        ))}
      </div>
      {!list.ok && <div className="mb-4"><Failure f={list} what="read articles" /></div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Your access" actions={ctx.data.can_create ? <Link href={`${ADMIN_BASE}/articles/new`} className={BTN_PRIMARY}>New draft</Link> : undefined}>
          <ul className="space-y-2 text-sm" data-testid="access-list">
            <li>Create drafts: <Badge tone={ctx.data.can_create ? "success" : "neutral"}>{ctx.data.can_create ? "allowed" : "not allowed"}</Badge></li>
            <li>Read articles: <Badge tone={ctx.data.can_read ? "success" : "neutral"}>{ctx.data.can_read ? "allowed" : "not allowed"}</Badge></li>
            <li>Read audit log: <Badge tone={ctx.data.can_read_audit ? "success" : "neutral"}>{ctx.data.can_read_audit ? "allowed" : "not allowed"}</Badge></li>
          </ul>
          <p className="mt-3 text-xs text-mist">Every action is re-authorized by the database at the moment you act: live session, active policy, role/grant scope and fresh TOTP.</p>
        </Panel>
        <Panel title="Recent audit events" actions={ctx.data.can_read_audit ? <Link href={`${ADMIN_BASE}/audit`} className="text-sm text-gold-300 underline">Open audit log</Link> : undefined}>
          {audit === null ? <p className="text-sm text-mist" data-testid="audit-not-authorized">Your role does not include audit access.</p>
            : !audit.ok ? <Failure f={audit} what="read the audit log" />
            : audit.data.length === 0 ? <EmptyState title="No audit events yet">Editorial actions are recorded here.</EmptyState>
            : <TableWrap label="Recent audit events"><table className="data-table w-full"><thead><tr><th>When</th><th>Action</th><th>Resource</th><th>Outcome</th></tr></thead><tbody>
                {audit.data.map((e) => <tr key={e.event_no}><td className="whitespace-nowrap">{fmtTs(e.occurred_at)}</td><td>{e.action_key}</td><td className="[overflow-wrap:anywhere]">{e.resource_key}</td><td><Badge tone={e.outcome === "success" ? "success" : "error"}>{e.outcome}</Badge></td></tr>)}
              </tbody></table></TableWrap>}
        </Panel>
      </div>
    </>
  );
}
