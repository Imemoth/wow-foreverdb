import { expect, type Page } from "@playwright/test";

export const PERSONAS = { selene: "st-selene", aldric: "st-aldric", brenna: "st-brenna", mira: "st-mira", tomas: "st-tomas", isolde: "st-isolde", garrick: "st-garrick", corin: "st-corin", pip: "st-pip" } as const;
export const ACT_AS = "Act as synthetic persona (preview-only)";

/** Open the preview as a fresh synthetic session (each Playwright page is a new tab => a fresh in-memory seed). */
export async function open(page: Page, path = "/admin-preview"): Promise<void> {
  await page.goto(path);
  await expect(page.getByText("DEMO / ISOLATED PREVIEW — NO PRODUCTION ACCESS")).toBeVisible();
}

export async function actAs(page: Page, who: keyof typeof PERSONAS): Promise<void> {
  await page.getByLabel(ACT_AS).selectOption(PERSONAS[who]);
}

export async function go(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: new RegExp(`^${name}`) }).click();
}

/** The newest toast of a tone (several can be stacked; a text filter selects a specific one). */
export const toast = (page: Page, tone: "success" | "error" | "warning" | "info", text?: string | RegExp) => (text ? page.getByTestId(`toast-${tone}`).filter({ hasText: text }) : page.getByTestId(`toast-${tone}`)).last();

export const GOOD = {
  title: "A perfectly valid preview title",
  summary: "A summary that is comfortably longer than twenty characters for validation.",
  body: "## Heading\n\nThis body is comfortably longer than eighty characters so the synthetic preview article passes validation and review.\n\n- one\n- two",
};

export async function fillEditor(page: Page, o: { slug?: string; title?: string; summary?: string; body?: string; featured?: boolean; tags?: string }): Promise<void> {
  if (o.slug !== undefined) await page.getByLabel("Slug (permanent)").fill(o.slug);
  await page.getByLabel("Title", { exact: true }).fill(o.title ?? GOOD.title);
  await page.getByLabel("Summary").fill(o.summary ?? GOOD.summary);
  await page.getByRole("textbox", { name: "Markdown" }).fill(o.body ?? GOOD.body);
  if (o.tags !== undefined) await page.getByLabel("Tags").fill(o.tags);
  if (o.featured !== undefined) await page.getByLabel(/^Featured/).setChecked(o.featured);
}

/** Creates a draft as the current persona and lands on its detail page. */
export async function createDraft(page: Page, slug: string, extra: Parameters<typeof fillEditor>[1] = {}): Promise<void> {
  await go(page, "Articles / News");
  await page.getByTestId("new-draft").click();
  await fillEditor(page, { slug, ...extra });
  await page.getByTestId("save-draft").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(extra.title ?? GOOD.title);
}
