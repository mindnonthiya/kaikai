import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 2,
  use: { baseURL: "http://127.0.0.1:3113", trace: "on-first-retry" },
  webServer: { command: "npm run dev -- -p 3113", url: "http://127.0.0.1:3113", reuseExistingServer: false, timeout: 120_000 },
  projects: [
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
  ],
});
