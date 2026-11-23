import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Safe Markdown for private drafts and published previews. react-markdown renders React elements (never raw HTML, never
 * dangerouslySetInnerHTML); on top of that: only absolute https links survive (everything else, including javascript:, data:,
 * relative and protocol-relative URLs, is dropped), images/embeds are not allowed in article bodies (images come only from the
 * rights-verified registry), and links carry rel=noopener noreferrer nofollow ugc.
 */
export const safeUrl = (url: string): string => (/^https:\/\/[^\s<>"'`\\]+$/.test(url) ? url : "");

export function Markdown({ source }: { source: string }): ReactNode {
  return (
    <div className="prose-fdb">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        disallowedElements={["img", "iframe", "script", "style", "object", "embed", "form", "input", "button"]}
        unwrapDisallowed
        components={{ a: ({ href, children }) => (href ? <a href={href} rel="noopener noreferrer nofollow ugc" target="_blank">{children}</a> : <span>{children}</span>) }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
