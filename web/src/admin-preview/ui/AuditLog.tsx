"use client";
import { useMemo, useState } from "react";
import { fmtDate, fmtTs, canReadAudit, sessionActive, sessionView } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";
import { ResultBadge } from "./common";
import { BTN_GHOST, Badge, EmptyState, FIELD, Mono, Notice, PageHeader, TableWrap } from "./primitives";

export function AuditLog() {
  const { state: s } = useAdmin();
  const v = sessionView(s);
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [result, setResult] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const readable = useMemo(() => s.audit.filter((e) => canReadAudit(s, e)), [s]);
  const actors = [...new Map(readable.map((e) => [e.actorId ?? e.actorName, e.actorName])).entries()];
  const actions = [...new Set(readable.map((e) => e.action))].sort();
  const rows = readable
    .filter((e) => (actor === "all" || (e.actorId ?? e.actorName) === actor) && (action === "all" || e.action === action) && (result === "all" || e.result === result)
      && (!from || fmtDate(e.at) >= from) && (!to || fmtDate(e.at) <= to)
      && (!text || `${e.targetLabel} ${e.correlationId} ${e.reason ?? ""}`.toLowerCase().includes(text.toLowerCase())))
    .slice().sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const hidden = s.audit.length - readable.length;
  const clear = (): void => { setActor("all"); setAction("all"); setResult("all"); setFrom(""); setTo(""); setText(""); };

  return (
    <>
      <PageHeader title="Audit Log" eyebrow="Governance" cap="simulated">
        Inspect the synthetic audit trail. Events created by what you do in this preview are labelled <Badge tone="info">Preview-only</Badge>; seeded history is labelled <Badge tone="neutral">Sample</Badge>. Denied attempts are recorded too.
      </PageHeader>
      {!sessionActive(v) ? <Notice tone="warning" title="Not signed in">Audit visibility depends on your permissions.</Notice>
        : readable.length === 0 ? <EmptyState title="No audit access">{v.persona?.name} holds neither <code>audit.editorial.read</code> nor <code>audit.staff.read</code>. Editors can read editorial audit only through a scoped grant; staff audit is Administrator/Owner.</EmptyState>
        : (
          <>
            {hidden > 0 && <div className="mb-4"><Notice tone="info" role="status" title={`${hidden} event(s) hidden by your permissions`}>You can read {readable.length} of {s.audit.length}. Editorial events need <code>audit.editorial.read</code>; staff, session and ceremony events need <code>audit.staff.read</code>.</Notice></div>}
            <form role="search" aria-label="Filter audit events" onSubmit={(e) => e.preventDefault()} className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,1fr)_1fr_1fr_auto]">
              <label className="text-xs text-mist">User<select className={`${FIELD} mt-1 w-full`} value={actor} onChange={(e) => setActor(e.target.value)}><option value="all">All users</option>{actors.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></label>
              <label className="text-xs text-mist">Action<select className={`${FIELD} mt-1 w-full`} value={action} onChange={(e) => setAction(e.target.value)}><option value="all">All actions</option>{actions.map((a) => <option key={a}>{a}</option>)}</select></label>
              <label className="text-xs text-mist">Result<select className={`${FIELD} mt-1 w-full`} value={result} onChange={(e) => setResult(e.target.value)}><option value="all">All results</option><option value="success">Success</option><option value="denied">Denied</option></select></label>
              <label className="text-xs text-mist">Search<input type="search" className={`${FIELD} mt-1 w-full`} placeholder="Target, correlation id, reason" value={text} onChange={(e) => setText(e.target.value)} /></label>
              <label className="text-xs text-mist">From<input type="date" className={`${FIELD} mt-1 w-full`} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="text-xs text-mist">To<input type="date" className={`${FIELD} mt-1 w-full`} value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <div className="flex items-end"><button type="button" className={BTN_GHOST} onClick={clear}>Clear</button></div>
            </form>
            <p role="status" aria-live="polite" className="mb-2 text-xs text-mist" data-testid="audit-count">{rows.length} of {readable.length} visible events</p>
            {rows.length === 0 ? <EmptyState title="No events match" action={<button type="button" className={BTN_GHOST} onClick={clear}>Clear filters</button>}>Adjust the filters.</EmptyState> : (
              <TableWrap label="Audit events">
                <table className="data-table" data-testid="audit-table">
                  <caption className="sr-only">Synthetic audit events, newest first</caption>
                  <thead><tr><th scope="col">Timestamp (UTC)</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Result</th><th scope="col">Permission</th><th scope="col">Correlation</th><th scope="col">Origin</th></tr></thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id} data-testid="audit-row" data-result={e.result} data-action={e.action}>
                        <td className="whitespace-nowrap text-xs">{fmtTs(e.at).replace(" UTC", "")}</td>
                        <td className="whitespace-nowrap text-xs">{e.actorName}</td>
                        <td className="font-mono text-xs text-gold-300">{e.action}</td>
                        <td className="min-w-48 max-w-xs text-xs">{e.targetLabel}{e.reason && <span className="mt-0.5 block max-w-sm text-mist">{e.reason}</span>}</td>
                        <td><ResultBadge r={e.result} /></td>
                        <td className="whitespace-nowrap">{e.permission ? <Mono>{e.permission}</Mono> : <span className="text-xs text-mist">—</span>}</td>
                        <td className="whitespace-nowrap"><Mono>{e.correlationId}</Mono></td>
                        <td>{e.seeded ? <Badge tone="neutral" title="Synthetic sample event">Sample</Badge> : <Badge tone="info" title="Created in this tab by a simulated operation">Preview-only</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </>
        )}
    </>
  );
}
