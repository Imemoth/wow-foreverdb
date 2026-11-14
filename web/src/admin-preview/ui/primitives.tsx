"use client";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { Tone } from "../domain/selectors";
import { useAdmin } from "../state/AdminProvider";

const TONE: Record<Tone, string> = {
  success: "border-conf-high/50 bg-conf-high/10 text-conf-high",
  warning: "border-conf-medium/55 bg-conf-medium/10 text-conf-medium",
  error: "border-danger/55 bg-danger/10 text-danger",
  info: "border-violet-400/55 bg-violet-500/15 text-violet-300",
  neutral: "border-ink-600 bg-ink-800/80 text-mist",
};
/** Glyphs make tone readable without colour (WCAG 1.4.1). */
const GLYPH: Record<Tone, string> = { success: "✓", warning: "▲", error: "✕", info: "●", neutral: "○" };

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE[tone]}`}>
      <span aria-hidden="true" className="text-[0.65rem]">{GLYPH[tone]}</span>
      {children}
    </span>
  );
}

export type Capability = "implemented" | "simulated" | "future";
const CAP: Record<Capability, { label: string; cls: string; title: string }> = {
  implemented: { label: "Backend implemented", cls: "border-conf-high/50 text-conf-high bg-conf-high/10", title: "A reviewed backend capability exists on main; it is inactive and deliberately not connected to this preview." },
  simulated: { label: "Simulated", cls: "border-violet-400/60 text-violet-300 bg-violet-500/15 border-dashed", title: "Works in this preview against synthetic in-browser data only. No backend exists yet or it is not connected." },
  future: { label: "Future", cls: "border-ink-600 text-mist bg-ink-800/60", title: "Planned (see the roadmap). Not built, not simulated." },
};
export function CapBadge({ kind, label }: { kind: Capability; label?: string }) {
  const c = CAP[kind];
  return <span title={c.title} className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide ${c.cls}`}>{label ?? c.label}</span>;
}

export function Notice({ tone = "info", title, children, role }: { tone?: Tone; title?: string; children?: ReactNode; role?: "status" | "alert" }) {
  return (
    <div role={role} className={`rounded-lg border px-4 py-3 text-sm ${TONE[tone]}`}>
      {title && <p className="font-semibold"><span aria-hidden="true">{GLYPH[tone]} </span>{title}</p>}
      {children && <div className={title ? "mt-1 text-parchment/90" : "text-parchment/90"}>{children}</div>}
    </div>
  );
}

export function PageHeader({ title, eyebrow, actions, children, cap }: { title: string; eyebrow?: string; actions?: ReactNode; children?: ReactNode; cap?: Capability }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const { shouldFocusHeading } = useAdmin();
  // Client-side navigation moves focus to the new page heading (screen-reader announcement); the first view of a page load does not.
  useEffect(() => { if (shouldFocusHeading()) ref.current?.focus({ preventScroll: true }); }, [shouldFocusHeading]);
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-bronze-400">{eyebrow}</p>}
        <h1 ref={ref} tabIndex={-1} className="panel-title text-2xl font-semibold outline-none sm:text-3xl">{title}</h1>
        {cap && <div className="mt-2"><CapBadge kind={cap} /></div>}
        {children && <div className="mt-2 max-w-3xl text-sm text-mist">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, children, actions, id, className = "" }: { title?: string; children: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  const hid = useId();
  return (
    <section aria-labelledby={title ? hid : undefined} id={id} className={`panel p-4 sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 id={hid} className="panel-title text-lg">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-600 px-6 py-10 text-center">
      <p className="panel-title text-lg">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-mist">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading preview data…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-4 p-6">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="h-8 w-1/3 animate-pulse rounded bg-ink-800" />
      <div aria-hidden="true" className="h-28 animate-pulse rounded-lg bg-ink-800/70" />
      <div aria-hidden="true" className="h-28 animate-pulse rounded-lg bg-ink-800/50" />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={tid}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={`m-auto max-h-[90vh] ${wide ? "w-[min(94vw,48rem)]" : "w-[min(94vw,34rem)]"} rounded-xl border border-ink-600 bg-ink-900 p-0 text-parchment shadow-2xl backdrop:bg-black/70`}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-5 py-4">
            <h2 id={tid} className="panel-title text-lg">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close dialog" className="rounded p-1 text-mist hover:text-white">✕</button>
          </div>
          <div className="overflow-y-auto px-5 py-4 text-sm">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-ink-700 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Field({ label, hint, error, children, id }: { label: string; hint?: ReactNode; error?: string; children: (p: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const hid = `${fid}-hint`, eid = `${fid}-err`;
  const described = [hint ? hid : "", error ? eid : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={fid} className="block text-sm font-medium text-parchment">{label}</label>
      {children({ id: fid, "aria-describedby": described, "aria-invalid": error ? true : undefined })}
      {hint && <p id={hid} className="text-xs text-mist">{hint}</p>}
      {error && <p id={eid} role="alert" className="text-xs font-medium text-danger"><span aria-hidden="true">✕ </span>{error}</p>}
    </div>
  );
}

export const FIELD = "field w-full";
export const BTN_PRIMARY = "btn-primary disabled:cursor-not-allowed";
export const BTN_GHOST = "btn-ghost disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_DANGER = "btn-ghost !border-danger/60 !text-danger hover:!bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50";
export const BTN_SM = "!min-h-8 !px-3 !py-1 text-sm";

export function Tabs<T extends string>({ tabs, value, onChange, label, children }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string; children?: ReactNode }) {
  const idBase = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const i = tabs.findIndex((t) => t.id === value);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const n = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
      onChange(n.id);
      requestAnimationFrame(() => document.getElementById(`${idBase}-${n.id}`)?.focus());
    }
  };
  return (
    <>
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="mb-4 flex flex-wrap gap-1 border-b border-ink-700">
        {tabs.map((t) => (
          <button
            key={t.id} id={`${idBase}-${t.id}`} role="tab" type="button" aria-selected={t.id === value} aria-controls={t.id === value ? `${idBase}-panel` : undefined}
            tabIndex={t.id === value ? 0 : -1} onClick={() => onChange(t.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm font-medium ${t.id === value ? "border-gold-400 text-gold-300" : "border-transparent text-mist hover:text-parchment"}`}
          >
            {t.label}{t.count !== undefined && <span className="ml-1.5 rounded-full bg-ink-800 px-1.5 text-xs text-mist">{t.count}</span>}
          </button>
        ))}
      </div>
      <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-${value}`}>{children}</div>
    </>
  );
}

/** Two-way view switch without a tabpanel relationship (for the editor's Write/Preview toggle on narrow screens). */
export function Segmented<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex overflow-hidden rounded-lg border border-ink-600">
      {options.map((o) => <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)} className={`px-3 py-1.5 text-sm ${o.id === value ? "bg-violet-500/30 text-gold-300" : "text-mist hover:text-parchment"}`}>{o.label}</button>)}
    </div>
  );
}

export function TableWrap({ children, label }: { children: ReactNode; label: string }) {
  return <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-lg border border-ink-700">{children}</div>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="[overflow-wrap:anywhere] rounded bg-ink-950/70 px-1.5 py-0.5 font-mono text-[0.78rem] text-gold-300">{children}</code>;
}

export function ConfirmDialog({ open, title, onCancel, onConfirm, confirmLabel, danger, children, busy }: { open: boolean; title: string; onCancel: () => void; onConfirm: () => void; confirmLabel: string; danger?: boolean; children: ReactNode; busy?: boolean }) {
  return (
    <Modal open={open} onClose={onCancel} title={title} footer={<>
      <button type="button" className={BTN_GHOST} onClick={onCancel}>Cancel</button>
      <button type="button" className={danger ? BTN_DANGER : BTN_PRIMARY} onClick={onConfirm} disabled={busy}>{confirmLabel}</button>
    </>}>
      {children}
    </Modal>
  );
}
