import { expect, test } from "@playwright/test";

// Demo data was removed, so these only cover pages and guards that work without signing in.
// Signed-in flows (menus, packaging, sales) need a real Supabase account.

test("login page renders without horizontal overflow", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "เข้าสู่ระบบ kaikai" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});

test("signup page is reachable from login", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "สมัครใช้งานฟรี" }).click();
  await expect(page.getByRole("heading", { name: "สร้างบัญชีร้านของคุณ" })).toBeVisible();
});

test("protected pages send signed-out visitors to login", async ({ page }) => {
  for (const path of ["/dashboard", "/sales/new", "/ingredients"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("CSV export refuses signed-out requests", async ({ request }) => {
  const response = await request.get("/api/reports/export?range=7d", { maxRedirects: 0 });
  expect([307, 401]).toContain(response.status());
});
