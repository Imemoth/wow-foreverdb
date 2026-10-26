import { Children, isValidElement, type ReactNode } from "react";
import Link from "next/link";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHeadingIdAssigner } from "@/lib/content/toc";

/**
 * Safe Markdown: raw HTML is skipped (never parsed), there is no MDX/JS
 * execution, URLs pass react-markdown's protocol allowlist, and images are
 * restricted to repository-hosted /content-images/.
 */

/** Plain text of a heading's rendered children (bold/code/links resolve to their inner text). */
function childrenToText(children: ReactNode): string {
  return Children.toArray(children)
    .map((c) => {
      if (typeof c === "string" || typeof c === "number") return String(c);
      if (isValidElement<{ children?: ReactNode }>(c)) return childrenToText(c.props.children);
      return "";
    })
    .join("");
}

export function Markdown({ source }: { source: string }) {
  // A fresh assigner per render: ids must be stable within one document but never leak a counter
  // across different articles rendered by the same server process (see lib/content/toc.ts).
  const assignId = createHeadingIdAssigner();
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
    // Anchor target for the guide reader's table of contents (lib/content/toc.ts's extractGuideToc
    // computes the identical id from the same raw source, so #href always resolves).
    h2({ children }) {
      return <h2 id={assignId(childrenToText(children))}>{children}</h2>;
    },
  };
  return (
    <div className="prose-fdb">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{source}</ReactMarkdown>
    </div>
  );
}
