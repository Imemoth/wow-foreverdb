import { expect, test } from "./fixtures";

test("home: honest banner, central search and entry points", async ({ page }) => {
  await page.goto("/");
  if (process.env.FOREVERDB_DATA_SOURCE === "postgres") await expect(page.getByText(/Observed data · publication #\d+/)).toBeVisible();
  else await expect(page.getByRole("note").first()).toContainText("synthetic sample data");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByLabel("Search items, creatures, nodes or a game ID").fill("copper");
  await page.getByRole("button", { name: "Search database" }).click();
  await expect(page).toHaveURL(/\/database\?q=copper/);
  await expect(page.getByRole("heading", { name: /2 results for “copper”/ })).toBeVisible();
});

test("search by exact ID, filters persist in the URL and Back/Forward restores state", async ({ page }) => {
  await page.goto("/database?q=2770");
  await expect(page.getByRole("link", { name: "Copper Ore" }).first()).toBeVisible();
  await page.goto("/database?kind=mining");
  await page.getByLabel("Zone").selectOption({ label: "Tirisfal Glades" });
  await expect(page).toHaveURL(/kind=mining/);
  await expect(page).toHaveURL(/zone=1420/);
  await expect(page.getByLabel("Zone")).toHaveValue("1420");
  await page.goBack();
  await expect(page).not.toHaveURL(/zone=1420/);
  await expect(page.getByLabel("Zone")).toHaveValue("");
  await page.goForward();
  await expect(page.getByLabel("Zone")).toHaveValue("1420");
});

test("blank global enumeration is refused with guidance", async ({ page }) => {
  await page.goto("/database?category=item");
  await expect(page.getByRole("heading", { name: "Start browsing" })).toBeVisible();
  await page.goto("/database?q=a%25");
  await expect(page.getByRole("alert").filter({ hasText: "cannot contain" })).toBeVisible();
});

test("item -> source -> item cross-navigation with observed-rate labelling", async ({ page }) => {
  await page.goto("/item/2770");
  await expect(page.getByRole("heading", { level: 1, name: "Copper Ore" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Observed drop rate" })).toBeVisible();
  await expect(page.getByText("not Blizzard's drop chance")).toBeVisible();
  await page.getByRole("region", { name: /Observed sources of Copper Ore/ }).getByRole("link", { name: "Copper Vein" }).click();
  await expect(page).toHaveURL(/\/object\/1731/);
  await expect(page.getByRole("heading", { level: 1, name: "Copper Vein" })).toBeVisible();
  await page.getByRole("region", { name: /Items observed from Copper Vein/ }).getByRole("link", { name: "Shadowgem" }).click();
  await expect(page).toHaveURL(/\/item\/1210/);
  await page.goBack();
  await expect(page).toHaveURL(/\/object\/1731/);
});

test("creature levels are separate sections and insufficient rates are hidden", async ({ page }) => {
  await page.goto("/creature/1554");
  await expect(page.getByRole("heading", { name: "Level 6" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Level 7" })).toBeVisible();
  await expect(page.locator("#level-6").getByText("Too few samples").first()).toBeVisible();
  await expect(page.locator("#level-6").getByText("rate hidden: too few samples").first()).toBeAttached();
});

test("fishing pools hide synthetic IDs; disenchant-only items render", async ({ page }) => {
  await page.goto("/object/-184513");
  await expect(page.getByText("no stable game ID")).toBeVisible();
  await page.goto("/item/6585");
  await expect(page.getByRole("heading", { name: "Disenchants into" })).toBeVisible();
});

test("zone directory filters and empty states", async ({ page }) => {
  await page.goto("/zone/1420");
  await expect(page.getByRole("heading", { level: 1, name: "Tirisfal Glades" })).toBeVisible();
  await page.getByRole("link", { name: /^Mining/ }).click();
  await expect(page).toHaveURL(/kind=mining/);
  await expect(page.getByRole("link", { name: "Copper Vein" }).first()).toBeVisible();
  await page.goto("/zone/1420?q=zzzz");
  await expect(page.getByText("Nothing observed for this filter yet")).toBeVisible();
});

test("zone directory never presents a zone-specific count for items (P2)", async ({ page }) => {
  await page.goto("/zone/1420?type=item");
  await expect(page.getByRole("columnheader", { name: "Observed in this zone" })).toBeVisible();
  await expect(page.getByText("In-zone obs.")).toHaveCount(0);
  await expect(page.getByText(/by inference/)).toBeVisible();
  const itemCells = await page.locator("tbody td.num").allInnerTexts();
  expect(itemCells.length).toBeGreaterThan(0);
  for (const c of itemCells) expect(c).toMatch(/^Not measured/);
  // Sources keep their genuine, measured in-zone observations.
  await page.goto("/zone/1420?type=creature");
  const creatureCells = await page.locator("tbody td.num").allInnerTexts();
  expect(creatureCells.length).toBeGreaterThan(0);
  for (const c of creatureCells) expect(c.trim()).toMatch(/^[\d.,\s]+$/);
});

test("item page presents zones as inferred, without a zone-specific count", async ({ page }) => {
  await page.goto("/item/2672");
  await expect(page.getByText(/Inferred: zones where a source of this item was observed/)).toBeVisible();
  await expect(page.getByText("related observations")).toHaveCount(0);
});

test("tooltips appear on hover and close with Escape", async ({ page }) => {
  await page.goto("/item/2770");
  await page.getByRole("region", { name: /Observed sources/ }).getByRole("link", { name: "Copper Vein" }).hover();
  const tip = page.getByRole("tooltip");
  await expect(tip).toContainText("Copper Vein");
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
});

test("unknown entities return 404 pages", async ({ page }) => {
  const r = await page.goto("/item/987654321");
  expect(r?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing observed here" })).toBeVisible();
  expect((await page.goto("/creature/abc"))?.status()).toBe(404);
});

test("news, guides, RSS and sample labelling", async ({ page, request }) => {
  await page.goto("/guides");
  await page.getByRole("link", { name: "Mining Copper Veins in Tirisfal Glades" }).click();
  await expect(page.getByText("Editorial sample.")).toBeVisible();
  await expect(page.getByRole("complementary").getByRole("link", { name: "Copper Ore" })).toBeVisible();
  const rss = await request.get("/news/rss.xml");
  expect(rss.headers()["content-type"]).toContain("application/rss+xml");
  expect(await rss.text()).toContain("<title>[Sample] Introducing the ForeverDB website (preview)</title>");
});
