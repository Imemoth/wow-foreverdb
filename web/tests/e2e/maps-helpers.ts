import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

export const MAP_URL = "/poc/maps/tirisfal";
export const IMG_W = 1002;
export const IMG_H = 668;
/** Rendering tolerance in CSS px. */
export const TOL = 1.5;

export async function openMap(page: Page, size?: { width: number; height: number }) {
  if (size) await page.setViewportSize(size);
  await page.goto(MAP_URL);
  await page.getByTestId("zone-map").waitFor();
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  await page.waitForFunction(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth === 1002);
  await settle(page);
}

/** Presses the zoom-in control n times, letting each zoom animation finish (Leaflet derives each step from the settled zoom). */
export async function zoomIn(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await page.locator(".leaflet-control-zoom-in").click();
    await page.waitForTimeout(400);
  }
}

export const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);

/** Minimal structural type of Playwright's `expect` (value, optional message) used by the geometry assertions. */
export type ExpectFn = (v: unknown, message?: string) => { toBe(x: unknown): void; toBeLessThan(n: number): void; toBeGreaterThan(n: number): void };

export interface Geometry {
  img: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  box: { left: number; top: number; right: number; bottom: number; width: number; height: number };
}

/** Actual DOM rectangles: the artwork <img> against the INNER (padding-box) rectangle of the map container. */
export function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const host = document.querySelector("[data-testid=zone-map]") as HTMLElement;
    const h = host.getBoundingClientRect();
    const left = h.left + host.clientLeft, top = h.top + host.clientTop;
    const box = { left, top, right: left + host.clientWidth, bottom: top + host.clientHeight, width: host.clientWidth, height: host.clientHeight };
    const r = document.querySelector(".leaflet-image-layer")!.getBoundingClientRect();
    return { img: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }, box };
  });
}

/** Whole image visible, aspect ratio preserved, not under-zoomed (touches the container on its limiting axis), letterbox centred. */
export function expectWholeImageFits(g: Geometry, expect: ExpectFn, label = "") {
  const { img, box } = g;
  const m = (s: string) => `${label} ${s} img=${JSON.stringify(img)} box=${JSON.stringify(box)}`;
  expect(img.left >= box.left - TOL, m("left corner inside")).toBe(true);
  expect(img.top >= box.top - TOL, m("top corner inside")).toBe(true);
  expect(img.right <= box.right + TOL, m("right corner inside")).toBe(true);
  expect(img.bottom <= box.bottom + TOL, m("bottom corner inside")).toBe(true);
  expect(Math.abs(img.width / img.height - IMG_W / IMG_H), m("aspect")).toBeLessThan(0.01);
  const fillX = img.width / box.width, fillY = img.height / box.height;
  expect(Math.max(fillX, fillY), m("fills limiting axis")).toBeGreaterThan(0.985);
  expect(Math.abs(img.left - box.left - (box.right - img.right)), m("horizontally centred")).toBeLessThan(TOL * 2);
  expect(Math.abs(img.top - box.top - (box.bottom - img.bottom)), m("vertically centred")).toBeLessThan(TOL * 2);
}

/** No blank space inside the viewport on any axis where the image is larger than the viewport; centred where smaller. */
export function expectNoBlankSpace(g: Geometry, expect: ExpectFn, label = "") {
  const { img, box } = g;
  const m = (s: string) => `${label} ${s} img=${JSON.stringify(img)} box=${JSON.stringify(box)}`;
  for (const [a0, a1, b0, b1, ax] of [[img.left, img.right, box.left, box.right, "x"], [img.top, img.bottom, box.top, box.bottom, "y"]] as const) {
    if (a1 - a0 >= b1 - b0 - TOL) {
      expect(a0 <= b0 + TOL, m(`${ax}: leading blank space`)).toBe(true);
      expect(a1 >= b1 - TOL, m(`${ax}: trailing blank space`)).toBe(true);
    } else {
      expect(Math.abs(a0 - b0 - (b1 - a1)), m(`${ax}: centred when smaller`)).toBeLessThan(TOL * 2);
    }
  }
}

export async function touchSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Real touch drag via the DevTools protocol (Playwright's touchscreen only supports taps). */
export async function touchDrag(cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Worst distance (px) between each visible marker's centre and its Companion-model position on the rendered image. */
export function markerError(page: Page) {
  return page.evaluate(() => {
    const img = document.querySelector(".leaflet-image-layer")!.getBoundingClientRect();
    const host = document.querySelector("[data-testid=zone-map]")!.getBoundingClientRect();
    let worst = 0, checked = 0;
    for (const m of Array.from(document.querySelectorAll<HTMLElement>(".leaflet-marker-icon[data-x]"))) {
      const r = m.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < host.left || cx > host.right || cy < host.top || cy > host.bottom) continue;
      const ex = img.left + (Number(m.dataset.x) / 100) * img.width, ey = img.top + (Number(m.dataset.y) / 100) * img.height;
      worst = Math.max(worst, Math.hypot(cx - ex, cy - ey));
      checked++;
    }
    return { worst, checked };
  });
}

/**
 * Reads a regular file below `root` for a URL path with ONE open + fstat on the descriptor, so there is no check-then-use window
 * between "does it exist / is it a file" and "read it" (CodeQL js/file-system-race). Returns null for anything that is not a plain
 * file strictly inside `root` (traversal, missing, directory).
 */
export function readDistFile(root: string, urlPath: string): Buffer | null {
  const base = resolve(root);
  const file = resolve(base, "." + urlPath);
  if (!file.startsWith(base + sep)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    return fstatSync(fd).isFile() ? readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Existence check in a single call (no separate exists/stat pair). */
export const hasFile = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
