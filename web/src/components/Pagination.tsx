import Link from "next/link";

export function Pagination({ page, pageSize, total, hrefFor, maxPage }: {
  page: number; pageSize: number; total: number; hrefFor: (p: number) => string; maxPage: number;
}) {
  const last = Math.min(Math.max(1, Math.ceil(total / pageSize)), maxPage);
  if (last <= 1) return null;
  const pages = [...new Set([1, page - 1, page, page + 1, last])].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1.5 text-sm">
      {page > 1 && <Link className="btn-ghost" rel="prev" href={hrefFor(page - 1)}>← Previous</Link>}
      {pages.map((p, i) => (
        <span key={p} className="flex items-center gap-1.5">
          {i > 0 && p - pages[i - 1]! > 1 && <span className="text-mist" aria-hidden="true">…</span>}
          {p === page ? (
            <span aria-current="page" className="rounded-md border border-gold-500 px-3 py-1.5 font-semibold text-gold-300">{p}</span>
          ) : (
            <Link className="rounded-md border border-ink-600 px-3 py-1.5 no-underline hover:border-gold-500" href={hrefFor(p)}>{p}</Link>
          )}
        </span>
      ))}
      {page < last && <Link className="btn-ghost" rel="next" href={hrefFor(page + 1)}>Next →</Link>}
      {last === maxPage && total > maxPage * pageSize && (
        <span className="text-xs text-mist">Showing the first {maxPage * pageSize} results — refine your search.</span>
      )}
    </nav>
  );
}
