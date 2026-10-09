import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Safe Markdown: raw HTML is skipped (never parsed), there is no MDX/JS
 * execution, URLs pass react-markdown's protocol allowlist, and images are
 * restricted to repository-hosted /content-images/.
 */
const components: Components = {
  a({ href, children }) {
    if (!href) return <>{children}</>;
    if (href.startsWith("/") && !href.startsWith("//")) return <Link href={href}>{children}</Link>;
    if (/^https:\/\//.test(href)) return <a href={href} rel="noopener noreferrer nofollow">{children}</a>;
    return <>{children}</>;
  },
  img({ src, alt }) {
    if (typeof src !== "string" || !/^\/content-images\/[a-z0-9/_-]+\.(svg|png|jpg|webp)$/.test(src)) return null;
    // eslint-disable-next-line @next/next/no-img-element -- static repository asset
    return <img src={src} alt={alt ?? ""} loading="lazy" className="my-4 rounded-lg border border-ink-700" />;
  },
  h1({ children }) {
    return <h2>{children}</h2>; // the page owns the only h1
  },
};

export function Markdown({ source }: { source: string }) {
  return (
    <div className="prose-fdb">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{source}</ReactMarkdown>
    </div>
  );
}
