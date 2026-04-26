import { expect, test } from "@playwright/test";

test("landing page renders the zero-trust product narrative", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /zero-trust compliance engineered for dpdp/i })).toBeVisible();
  await expect(page.getByText("SYSTEM STATUS: COMPLIANT")).toBeVisible();
  await expect(page.getByRole("link", { name: /dashboard/i })).toBeVisible();
});

test("dashboard is protected and unauthenticated users land on login", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: /operator access/i })).toBeVisible();
  await expect(page.getByText(/fails closed/i)).toBeVisible();
});
