import Link from "next/link";
import { JsonLd } from "./JsonLd";

export interface Crumb { name: string; href?: string }

export function Breadcrumbs({ items, nonce, baseUrl }: { items: Crumb[]; nonce?: string; baseUrl: string }) {
  const all: Crumb[] = [{ name: "Home", href: "/" }, ...items];
  return (
    <>
      <nav aria-label="Breadcrumb" className="text-sm text-mist">
        <ol className="flex flex-wrap items-center gap-1.5">
          {all.map((c, i) => (
            <li key={`${c.name}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" className="text-ink-600">/</span>}
              {c.href && i < all.length - 1 ? (
                <Link href={c.href} className="text-mist hover:text-gold-300">{c.name}</Link>
              ) : (
                <span aria-current={i === all.length - 1 ? "page" : undefined} className="text-parchment">{c.name}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <JsonLd nonce={nonce} data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: all.map((c, i) => ({
          "@type": "ListItem", position: i + 1, name: c.name,
          ...(c.href ? { item: new URL(c.href, baseUrl).toString() } : {}),
        })),
      }} />
    </>
  );
}
