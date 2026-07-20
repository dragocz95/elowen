// Auth pipeline smoke: the REAL login form → BFF cookie mint → gate open (P0-1), and a mid-session
// daemon 401 tearing the shell back down to the login form (P0-2). Both exercise the real
// cookie/BFF/LoginGate path against the fake daemon; nothing is stubbed in the browser.
import { test, expect, ShellPage, ChatPage } from '../fixtures/index.ts';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from '../seed/fixtures.ts';

// P0-1 — a logged-out visitor signs in through the real form and lands in the authenticated shell,
// with no uncaught exceptions or console errors along the way. Runs under the `unauthed` project so the
// page starts with no session cookie (the `app` fixture is always authed, so it can't cover this).
test('@smoke P0-1 anonymous login lands in the shell with a clean console', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'unauthed', 'needs a logged-out page (unauthed project)');
  const shell = new ShellPage(page);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  // The login gate deliberately probes `/auth/me` and `/setup` while logged out; both answer 401, and the
  // browser logs a network-level "Failed to load resource: … 401" for each. That is expected, app-handled
  // noise (not a JS error), so filter those out — every real app console.error still fails the assertion.
  const isBenign = (text: string): boolean => /Failed to load resource:.*\b401\b/.test(text);
  page.on('console', (m) => { if (m.type() === 'error' && !isBenign(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  // Gate probed /auth/me → 401 → /setup needsSetup:false → the login form renders.
  await expect(shell.loginPassword).toBeVisible();

  await page.locator('input[type="text"]').fill(ADMIN_USERNAME);
  await shell.loginPassword.fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();

  // onAuthed flips the gate open (no reload): the password field is gone and the nav landmark mounts.
  await shell.waitForShell();

  // The authenticated shell renders the dashboard route without error.
  await page.goto('/dash');
  await expect(shell.nav).toBeVisible();
  await expect(shell.loginPassword).toHaveCount(0);

  expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});

// P0-2 — a session revoked upstream (the daemon 401s) must kick the app back to login and drop cached
// data, not strand the user in a half-broken shell. We revoke by clearing the session cookie: the BFF
// then answers every proxied call with 401, which is exactly what a stale/revoked daemon session yields.
// A real UI action (sending a chat message) fires the fetch that trips the 401 → AUTH_CLEARED → gate.
test('@smoke P0-2 a daemon 401 returns the app to login and clears the shell', async ({ app }) => {
  const chat = new ChatPage(app);
  const shell = new ShellPage(app);

  await chat.goto();
  await chat.waitForReady();

  // Revoke the session: from here every BFF-proxied elowenClient call gets a 401.
  await app.context().clearCookies();

  // A real send fires an elowenClient request immediately → 401 → clearToken() → AUTH_CLEARED_EVENT.
  await chat.sendMessage('are you still there?');

  // The gate flips to the login form (qc.clear() ran) and the chat shell is torn down — no stale data.
  await expect(shell.loginPassword).toBeVisible({ timeout: 15_000 });
  await expect(chat.composer).toHaveCount(0);
});
