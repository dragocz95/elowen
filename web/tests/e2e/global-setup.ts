// Playwright global setup: perform a REAL login through the app's own BFF login route (which mints the
// httpOnly session cookie), then persist that cookie as storage state for the `authed` project. This
// exercises the genuine cookie pipeline once, up front, instead of stubbing auth in the browser.
import { request, type FullConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ADMIN_USERNAME, ADMIN_PASSWORD } from './seed/fixtures.ts';
import { STORAGE_STATE } from '../../playwright.config.ts';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4598';
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post('/api/auth/login', { data: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD } });
  if (!res.ok()) {
    throw new Error(`E2E global setup: login failed (${res.status()} ${res.statusText()})`);
  }
  const path = resolve(STORAGE_STATE);
  mkdirSync(dirname(path), { recursive: true });
  await ctx.storageState({ path });
  await ctx.dispose();
}
