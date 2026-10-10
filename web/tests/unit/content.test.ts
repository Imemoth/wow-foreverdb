import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Markdown } from "@/components/Markdown";
import { loadAllArticles } from "@/lib/content/loader";

describe("editorial content", () => {
  it("every content file has valid, strict frontmatter", () => {
    const all = loadAllArticles();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const a of all) {
      expect(a.description.length).toBeLessThanOrEqual(200);
      expect(a.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });
  it("initial articles are labelled as editorial samples", () => {
    expect(loadAllArticles().every((a) => a.sample)).toBe(true);
  });
});

describe("safe Markdown rendering", () => {
  const render = (md: string) => renderToStaticMarkup(createElement(Markdown, { source: md }));
  it("drops raw HTML and scripts", () => {
    const html = render("Hello <script>alert(1)</script> <img src=x onerror=alert(1)> <iframe src=//evil></iframe>");
    expect(html).not.toMatch(/<script|onerror|<iframe/i);
  });
  it("neutralizes dangerous and protocol-relative links", () => {
    const html = render("[a](javascript:alert(1)) [b](//evil.example) [c](data:text/html,x) [d](https://ok.example) [e](/item/2770)");
    expect(html).not.toMatch(/javascript:|href="\/\/evil|data:text/);
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="/item/2770"');
  });
  it("only allows repository-hosted images", () => {
    expect(render("![x](https://tracker.example/p.gif)")).not.toContain("<img");
    expect(render("![x](/content-images/a.svg)")).toContain('src="/content-images/a.svg"');
  });
  it("demotes h1 so the page keeps a single h1", () => {
    expect(render("# Title")).toContain("<h2>Title</h2>");
  });
});
