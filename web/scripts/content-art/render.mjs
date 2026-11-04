// Render an SVG string to PNG with the pre-installed Chromium (Playwright).
import { chromium } from "@playwright/test";

export async function renderSvgToPng(svg, outPath, { width = 1920, height = 1080 } = {}) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}
