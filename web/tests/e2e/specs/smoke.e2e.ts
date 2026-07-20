import { test, expect } from '@playwright/test';

// Boot smoke: proves the full harness wiring — real Next server → fake daemon → real cookie/BFF/gate —
// stands up in both auth states. Each case is scoped to the project whose session state it needs.

test('@smoke authenticated admin lands in the app shell (no login form)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'authed', 'runs under the authed project only');
  await page.goto('/');
  // LoginGate probes /auth/me; with the stored cookie it opens the shell, so no password field renders.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('@smoke anonymous visitor gets the login form', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'unauthed', 'runs under the unauthed project only');
  await page.goto('/');
  // No session cookie → /auth/me 401 → /setup needsSetup:false → the login form is shown.
  await expect(page.locator('input[type="password"]')).toBeVisible();
});
