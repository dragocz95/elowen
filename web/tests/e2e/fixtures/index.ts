// The E2E test harness: `test.extend` giving every spec a pre-authed page (`app`), a scripted live
// stream (`sse`), and pre-navigation REST seeding (`seed`). Every spec imports `test`/`expect` from here
// instead of `@playwright/test`, so it inherits the fixtures and the per-test state reset.
import { test as base, expect, type Page } from '@playwright/test';
import { STORAGE_STATE } from '../../../playwright.config.ts';
import { DAEMON_URL } from './env.ts';
import { SseScript } from './SseScript.ts';
import { Seed } from './Seed.ts';

export interface HarnessFixtures {
  /** A page in a context that carries the admin session cookie (from global setup's real login) and the
   *  test Next server's baseURL — so `app.goto('/chat')` opens the shell already authenticated, no matter
   *  which Playwright project runs the spec. */
  app: Page;
  /** Push scripted `BrainEvent` frames into the chat's open SSE stream (defaults to the seeded session). */
  sse: SseScript;
  /** Override the fake daemon's canned REST answers / message history BEFORE navigating. */
  seed: Seed;
}

export const test = base.extend<HarnessFixtures & { isolate: void }>({
  // Isolate every test: wipe recorded sends + seed overrides in the shared fake-daemon process before the
  // body runs, so leftovers from a prior test can never bleed in. Auto so a spec need not opt in.
  isolate: [
    async ({ request }, use) => {
      await request.post(`${DAEMON_URL}/__test/reset`);
      await use();
    },
    { auto: true },
  ],

  seed: async ({ request }, use) => {
    await use(new Seed(request));
  },

  sse: async ({ request }, use) => {
    await use(new SseScript(request));
  },

  app: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ storageState: STORAGE_STATE, baseURL });
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
export { SseScript } from './SseScript.ts';
export { Seed } from './Seed.ts';
export { ShellPage } from '../pages/ShellPage.ts';
export { ChatPage } from '../pages/ChatPage.ts';
export type { StreamTarget } from './SseScript.ts';
