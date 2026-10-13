import { expect, test } from "@playwright/test";

// These run in demo mode (no Supabase env), using generated sample data.

test("dashboard renders important figures without horizontal overflow", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: /วันนี้ร้านเป็นอย่างไร/ })).toBeVisible();
  await expect(page.getByText("ยอดขายวันนี้")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("dashboard range tabs switch the period", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "เดือนนี้" }).click();
  await expect(page).toHaveURL(/range=month/);
  await expect(page.getByText("ยอดขายเดือนนี้")).toBeVisible();
});

test("sale composer recalculates totals", async ({ page }) => {
  await page.goto("/sales/new");
  await expect(page.getByRole("heading", { name: "เพิ่มยอดขาย" })).toBeVisible();
  await page.getByRole("button", { name: "เพิ่ม ข้าวไก่ต้มน้ำปลา" }).click();
  await expect(page.getByText("2 × ฿60")).toBeVisible();
});

test("sale composer survives invalid money input", async ({ page }) => {
  await page.goto("/sales/new");
  await page.locator("#sale-discount").fill("abc");
  await expect(page.getByRole("alert")).toContainText("ส่วนลดไม่ถูกต้อง");
  await expect(page.locator("#sale-save")).toBeDisabled();
});

test("signup page is reachable from login", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "สมัครใช้งานฟรี" }).click();
  await expect(page.getByRole("heading", { name: "สร้างบัญชีร้านของคุณ" })).toBeVisible();
});

test("CSV export responds", async ({ request }) => {
  const response = await request.get("/api/reports/export?range=7d");
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("text/csv");
  expect(await response.text()).toContain("ยอดสุทธิ (บาท)");
});
