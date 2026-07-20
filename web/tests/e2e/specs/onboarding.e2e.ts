// P0-8 — the fresh-install lane: an unauthed visitor on a box with no admin yet is routed to /onboarding,
// creates the FIRST admin (the daemon's count==0 bootstrap), and is logged straight into the shell — no
// manual login bounce. Nothing is stubbed in the browser; it rides the real cookie/BFF/gate pipeline.
//
// The daemon runs SETUP MODE while `users.count() === 0` — its global auth guard opens every route until
// the first admin exists (src/api/auth.ts:29), and `/setup` is public always. The BFF proxy forwards a
// tokenless request WITHOUT an Authorization header (app/api/[...path]/route.ts) so the daemon stays the
// sole guard: open during setup, 401 for every protected route thereafter. That is what makes this lane
// reachable — `GET /setup` and the first-admin `POST /users` land on the open daemon before any cookie
// can exist, then the auto-login mints the session.
import { test, expect, ShellPage } from '../fixtures/index.ts';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from '../seed/fixtures.ts';

test('@smoke P0-8 a fresh install routes to onboarding, creates the first admin, and lands in the shell', async ({ page, seed }, testInfo) => {
  test.skip(testInfo.project.name !== 'unauthed', 'needs a logged-out page (unauthed project)');

  // Arm the fresh-install lane: `/setup` reports needsSetup, `/users` create is open, count is 0.
  await seed.needsSetup(true);

  const shell = new ShellPage(page);

  // Visiting the app with no session → the gate finds needsSetup and routes to onboarding.
  await shell.goto('/');
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(shell.onboardingUsername).toBeVisible();
  await expect(shell.onboardingCreate).toBeVisible();

  // Create the first admin. `POST /users` (201) is the count==0 bootstrap; success auto-logs-in with the
  // same creds, which the fake `/auth/login` accepts only because they are the fixed admin pair.
  const createResponse = page.waitForResponse((r) => r.url().includes('/api/users') && r.request().method() === 'POST');
  const loginResponse = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
  await shell.createFirstAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);
  expect((await createResponse).status()).toBe(201);
  expect((await loginResponse).ok()).toBeTruthy();

  // Landed authenticated: an authed route now opens the shell (nav present, no login form) — the cookie the
  // auto-login minted carries through, so there is no bounce back to login/onboarding.
  await page.goto('/dash');
  await shell.waitForShell();
  await expect(page).toHaveURL(/\/dash/);
});
