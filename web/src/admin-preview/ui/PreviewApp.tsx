"use client";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { sessionActive, sessionView } from "../domain/selectors";
import { AdminProvider, useAdmin } from "../state/AdminProvider";
import { ArticleDetail } from "./ArticleDetail";
import { ArticleEditor } from "./ArticleEditor";
import { ArticleList } from "./ArticleList";
import { AuditLog } from "./AuditLog";
import { Dashboard } from "./Dashboard";
import { ReviewQueue } from "./ReviewQueue";
import { SessionGate } from "./SessionGate";
import { Settings } from "./Settings";
import { BASE, Shell } from "./Shell";
import { StaffDetail } from "./StaffDetail";
import { StaffList } from "./StaffList";
import { BTN_PRIMARY, EmptyState, LoadingState, Notice } from "./primitives";
import Link from "next/link";

export function PreviewView() {
  const { ready, state, openStepUp } = useAdmin();
  const pathname = usePathname() ?? BASE;
  const parts = pathname.slice(BASE.length).split("/").filter(Boolean);
  const v = sessionView(state);
  if (!ready) return <LoadingState />;
  const [section, id, leaf] = parts;
  if (section !== "settings" && !sessionActive(v)) return <SessionGate />;
  return (
    <>
      {v.status === "mfa_stale" && (
        <div className="mb-4" data-testid="stale-banner"><Notice tone="warning" role="status" title="TOTP freshness expired">
          Critical actions (publish, unpublish, highlighted approval, staff changes) need a TOTP verification from the last 15 minutes. Other actions still work.{" "}
          <button type="button" className={`${BTN_PRIMARY} !min-h-8 ml-2 text-sm`} onClick={openStepUp}>Re-verify now</button>
        </Notice></div>
      )}
      {(() => {
        switch (section) {
          case undefined: return <Dashboard />;
          case "articles":
            if (id === "new") return <ArticleEditor />;
            if (id && leaf === "edit") return <ArticleEditor key={id} articleId={id} />;
            if (id) return <ArticleDetail key={id} articleId={id} />;
            return <Suspense fallback={<LoadingState />}><ArticleList /></Suspense>;
          case "review": return <ReviewQueue />;
          case "staff": return id ? <StaffDetail key={id} staffId={id} /> : <StaffList />;
          case "audit": return <AuditLog />;
          case "settings": return <Settings />;
          default: return <EmptyState title="Page not found" action={<Link href={BASE} className={BTN_PRIMARY}>Back to Dashboard</Link>}>There is no Admin preview screen at this address.</EmptyState>;
        }
      })()}
    </>
  );
}

/** Rendered by the (persistent) preview layout, so in-memory state, toasts and dialogs survive client-side navigation between screens. */
export function PreviewFrame({ children }: { children: React.ReactNode }) {
  return (
    <AdminProvider>
      <Shell>{children}</Shell>
    </AdminProvider>
  );
}
