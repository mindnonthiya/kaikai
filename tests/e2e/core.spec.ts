import { expect, test } from "@playwright/test";

test("dashboard renders important figures without horizontal overflow", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /วันนี้ร้านเป็นอย่างไร/ })).toBeVisible();
  await expect(page.getByText("ยอดขายวันนี้")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("sale composer recalculates totals", async ({ page }) => {
  await page.goto("/sales/new");
  await expect(page.getByRole("heading", { name: "เพิ่มยอดขาย" })).toBeVisible();
  await page.getByRole("button", { name: "เพิ่ม ข้าวไก่ต้มน้ำปลา" }).click();
  await expect(page.getByText("2 × ฿60")).toBeVisible();
});

test("CSV export responds", async ({ request }) => {
  const response = await request.get("/api/reports/export");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("text/csv");
});
