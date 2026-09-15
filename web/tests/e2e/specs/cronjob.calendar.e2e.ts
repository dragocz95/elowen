// The cronjob plugin's calendar workbench, exercised against the REAL registry bundle.
//
// The cron page is a wide calendar with a selected-day agenda — not a register of rows — and every
// property here is one the HOST surface guarantees: the declared workbench measure (`data-page-measure`
// on the shell frame, the same contract Editor is pinned to), the month grid rendered as a native ARIA
// grid by the runtime's Calendar (react-day-picker beneath it), one frame per page, and the
// coarse-pointer touch floor on a date. The plugin's own recurrence logic, agenda pagination and
// drawer behaviour are asserted in its own repository; here the plugin must LOOK integrated.
//
// WHEN IT RUNS: only when the harness is pointed at a checkout that shipped the workbench bundle —
// `E2E_PLUGIN_DIRS` pointing at a registry `plugins/` directory whose cronjob manifest declares
// `web.layout: 'workbench'` and `web.requiresApiVersion` ≥ 17 AND a built `web/index.js`. Otherwise
// the page either does not exist or is still the legacy register, and the spec skips rather than
// asserting against a page that was never served.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/index.ts';
import { STORAGE_STATE } from '../../../playwright.config.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');

/** The registry cronjob, if the harness can reach a checkout that declares the workbench layout and
 *  has a built bundle. `null` = the plugin page is not measurable in this run. */
function workbenchCronjob(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '../../..');
  const roots = [join(repoRoot, 'plugins'),
    ...(process.env.E2E_PLUGIN_DIRS ?? '').split(':').map((dir) => dir.trim()).filter(Boolean)];
  for (const root of roots) {
    const dir = join(root, 'cronjob');
    const manifestPath = join(dir, 'elowen-plugin.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        web?: { entry?: string; layout?: string; requiresApiVersion?: number };
      };
      const entry = manifest.web?.entry;
      if (manifest.web?.layout === 'workbench' && entry && existsSync(resolve(dir, entry))) return true;
    } catch { /* malformed manifest → unreachable, like the loader treats it */ }
  }
  return false;
}

/** Open the cron page and wait until it has painted: the host renders nothing at all while the
 *  listing and the bundle are in flight, so measuring without this reads an empty document. */
async function openCalendar(page: Page, wait: string): Promise<void> {
  await page.goto('/p/cronjob');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator(wait)).toBeVisible();
}

test('the calendar workbench is framed at the workbench measure, with one frame', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout with the API 17 calendar workbench built');
  const armed = await seed.realPlugins();
  expect(armed.includes('cronjob'), 'the workbench checkout exists but the harness did not arm the cronjob bundle').toBe(true);

  await app.setViewportSize({ width: 1440, height: 900 });
  await app.goto('/p/cronjob');
  await expect(app.locator('h1')).toBeVisible();
  const frame = app.locator('[data-page-measure]');
  await expect(frame).toHaveAttribute('data-page-measure', 'workbench');
  expect(await frame.count()).toBe(1);
  // One frame, not two: the plugin owns its surface and the host adds no second page column around a
  // page that declares the workbench.
  expect(await app.evaluate(() => document.querySelectorAll('.workspace-shell').length)).toBe(1);
});

test('the month grid is the runtime Calendar: a real grid with seven weekday headers', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  await app.setViewportSize({ width: 1440, height: 900 });
  // The grid semantics come from the host Calendar (data-slot="calendar" is the shadcn Root marker the
  // runtime primitive sets), NOT from a hand-rolled table: one grid, seven weekday headers.
  await openCalendar(app, '[data-page-measure="workbench"] [role="grid"]');
  expect(await app.evaluate(() => document.querySelectorAll('[role="grid"][data-slot="calendar"]').length)).toBe(1);
  await expect(app.locator('[role="grid"] [role="columnheader"]')).toHaveCount(7);
});

test('day targets meet the 44px floor on a coarse pointer', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  const size = { width: 390, height: 844 };
  const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await page.goto('/p/cronjob');
    await expect(page.locator('h1')).toBeVisible();
    const day = page.locator('[role="grid"][data-slot="calendar"] [role="gridcell"] button').first();
    await expect(day).toBeVisible();
    const box = (await day.boundingBox())!;
    expect(box.width, 'a mobile day target is a full touch target').toBeGreaterThanOrEqual(44);
    expect(box.height, 'a mobile day target is a full touch target').toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});
