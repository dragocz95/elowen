import { defineConfig, devices } from '@playwright/test';

// Throwaway ports so an E2E run never collides with a real dev daemon (:4400) or web (:4500).
const FAKE_DAEMON_PORT = Number(process.env.FAKE_DAEMON_PORT ?? 4599);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4598);
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const DAEMON_URL = `http://127.0.0.1:${FAKE_DAEMON_PORT}`;

// Where global setup stashes the authenticated storage state (a real login through the app → cookie).
export const STORAGE_STATE = 'tests/e2e/.auth/admin.json';

export default defineConfig({
  testDir: './tests/e2e/specs',
  testMatch: '**/*.e2e.ts',
  // The fake daemon keeps shared in-process state (open streams, recorded turns), so runs are serial.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
  },
  projects: [
    // Authenticated admin: reuses the cookie global setup saved.
    { name: 'authed', use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE } },
    // Anonymous visitor: no stored session, so the app should fall through to the login form.
    { name: 'unauthed', use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } } },
  ],
  webServer: [
    {
      // Node type-strips the TS entry directly (no build step); mirrors the repo's `serve` script.
      command: 'node --experimental-strip-types tests/e2e/fake-daemon/server.ts',
      url: `${DAEMON_URL}/health`,
      reuseExistingServer: !process.env.CI,
      env: { FAKE_DAEMON_PORT: String(FAKE_DAEMON_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The REAL Next server, pointed at the fake daemon via the same env var prod uses.
      command: `next dev -p ${WEB_PORT} -H 127.0.0.1`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ELOWEN_DAEMON_URL: DAEMON_URL, PORT: String(WEB_PORT) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
