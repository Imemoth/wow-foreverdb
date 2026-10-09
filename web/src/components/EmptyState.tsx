export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel flex flex-col items-center gap-2 px-6 py-10 text-center">
      <svg viewBox="0 0 48 48" className="h-10 w-10 text-bronze-400" aria-hidden="true">
        <circle cx="21" cy="21" r="12" fill="none" stroke="currentColor" strokeWidth="3" />
        <path d="m30 30 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <p className="font-semibold text-parchment">{title}</p>
      {children && <div className="max-w-prose text-sm text-mist">{children}</div>}
    </div>
  );
}
