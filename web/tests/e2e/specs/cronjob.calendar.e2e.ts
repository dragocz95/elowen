// The cronjob plugin's calendar workbench, exercised against the REAL registry bundle.
//
// The cron page is a wide calendar with a selected-day agenda — not a register of rows — and every
// property here is one the HOST surface guarantees: the declared workbench measure (`data-page-measure`
// on the shell frame, the same contract Editor is pinned to), the month grid rendered as a native ARIA
// grid by the runtime's Calendar (react-day-picker beneath it), one frame per page, the keyboard
// navigation that grid owns, and the coarse-pointer touch floor on a date. The plugin's own recurrence
// logic, agenda pagination and drawer behaviour are asserted in its own repository; here the plugin
// must LOOK integrated and BEHAVE like a real date grid in a real engine.
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
 *  has a built bundle. `false` = the plugin page is not measurable in this run. */
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

/** The element's box once the surface around it has finished animating.
 *
 *  The host overlay opens with a zoom/fade, and every box sampled during it is the ANIMATION's box —
 *  a day button whose layout size is exactly 44px measures ~43.1 halfway through the zoom. Waiting on
 *  the running animations rather than on a sampled-stability heuristic measures the target the finger
 *  actually gets, with a cap so an indefinite animation cannot hang the spec. */
async function settledBox(page: Page, selector: string): Promise<{ width: number; height: number }> {
  return await page.evaluate(async (sel) => {
    const node = document.querySelector(sel) as HTMLElement;
    const running = document.getAnimations().map((animation) => animation.finished.catch(() => undefined));
    await Promise.race([
      Promise.all(running),
      new Promise((done) => window.setTimeout(done, 3_000)),
    ]);
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, selector);
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
  // One frame, not two: the plugin owns its surface under `WorkspacePage`/`WorkspaceHero`, and the
  // host adds no second page column (or a register-style WorkspaceShell) around a workbench page.
  expect(await app.evaluate(() => {
    return document.querySelectorAll('.workspace-shell').length
      + document.querySelectorAll('[data-page-measure]').length;
  })).toBe(1);
  // A workbench page, never the retired register. The only table on it is the date grid itself:
  // react-day-picker v9 renders the month as a real `<table role="grid">`.
  expect(await app.locator('table:not([data-slot="calendar"] table)').count(), 'no register table').toBe(0);
});

test('the month grid is the runtime Calendar: a real grid with seven weekday headers', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  await app.setViewportSize({ width: 1440, height: 900 });
  // The grid semantics come from the host Calendar (data-slot="calendar" is the shadcn Root marker the
  // runtime primitive sets), NOT from a hand-rolled table: one grid, seven weekday headers.
  await openCalendar(app, '[data-page-measure="workbench"] [role="grid"]');
  // The grid lives INSIDE the shadcn Root marker the runtime Calendar sets (`data-slot="calendar"`).
  expect(await app.evaluate(() => document.querySelectorAll('[data-slot="calendar"] [role="grid"]').length)).toBe(1);
  // Seven weekday labels: react-day-picker v9 names them grid columnheaders, falling back to its
  // `colgroup` columns on builds that render weekdays as plain <col> cells.
  const weekdayLabels = await app.evaluate(() => {
    const headers = document.querySelectorAll('[data-slot="calendar"] thead th');
    return headers.length === 7 ? 'th'
      : document.querySelectorAll('[data-slot="calendar"] colgroup col').length === 7 ? 'col' : 'none';
  });
  expect(weekdayLabels !== 'none', `the runtime Calendar rendered no weekday labels (shape: ${weekdayLabels})`).toBe(true);
  // The plugin's ledger IS the day button, so a day still carries the library's own accessible name
  // with the plugin's occurrence count folded into it.
  const named = await app.evaluate(() => [...document.querySelectorAll('[data-slot="calendar"] [role="grid"] button')]
    .every((button) => (button.getAttribute('aria-label') ?? '').length > 0));
  expect(named, 'every day button keeps an accessible name').toBe(true);
});

test('the month grid keeps react-day-picker keyboard navigation through the plugin ledger', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  await app.setViewportSize({ width: 1440, height: 900 });
  await openCalendar(app, '[data-page-measure="workbench"] [role="grid"]');

  // The plugin replaces `components.DayButton`; an override that drops the library's props or its
  // focus effect leaves the arrows dead while the page still LOOKS right. This is that regression.
  const focusedDay = () => app.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.closest('[data-day]')?.getAttribute('data-day') ?? null);

  await app.locator('[data-slot="calendar"] [role="grid"] button[tabindex="0"]').first().focus();
  const start = await focusedDay();
  expect(start, 'the roving tab stop lands on a day').not.toBeNull();

  await app.keyboard.press('ArrowRight');
  const right = await focusedDay();
  expect(right, 'ArrowRight moves focus to the next date').not.toBe(start);

  await app.keyboard.press('ArrowDown');
  const down = await focusedDay();
  expect(down, 'ArrowDown moves focus a week forward').not.toBe(right);
  expect(Date.parse(down!) - Date.parse(right!)).toBe(7 * 86_400_000);

  await app.keyboard.press('Home');
  const home = await focusedDay();
  expect(home, 'Home moves focus within the week').not.toBe(down);
  await app.keyboard.press('End');
  expect(await focusedDay(), 'End moves focus within the week').not.toBe(home);

  // PageUp pages the GRID, so the month it names is what moves. `showOutsideDays={false}` hides the
  // spill-over dates, which makes the focused date a weaker signal than the grid's own label.
  const monthLabel = () => app.locator('[data-slot="calendar"] [role="grid"]').getAttribute('aria-label');
  const beforePage = await monthLabel();
  await app.keyboard.press('PageUp');
  await expect.poll(monthLabel, { message: 'PageUp pages the grid a month back' }).not.toBe(beforePage);
});

test('the selected day opens its job in a drawer and returns focus when it closes', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  await app.setViewportSize({ width: 1440, height: 900 });
  await openCalendar(app, '[data-testid="cron-agenda"]');
  const card = app.locator('[data-testid="cron-agenda"] button').first();
  await card.focus();
  const opener = await app.evaluate(() => (document.activeElement as HTMLElement).getAttribute('aria-label'));
  await card.click();

  const drawer = app.locator('[role="dialog"]').first();
  await expect(drawer).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  // Focus return is the HOST overlay's contract; the plugin's part is raising the drawer from a real
  // control that still exists when it closes.
  expect(await app.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('aria-label'))).toBe(opener);
});

test('day targets meet the 44px floor on a coarse pointer', async ({ browser, seed }, testInfo) => {
  test.setTimeout(180_000); // a phone flow boots the app shell AND the workbench inside its window
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
  await seed.realPlugins();

  const size = { width: 390, height: 844 };
  const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await page.goto('/p/cronjob');
    await expect(page.locator('h1')).toBeVisible();
    // Mobile is agenda-first: the seven-day strip is the surface, and the month grid is NOT squeezed
    // into the page — it lives inside the host Modal the `Date` chooser opens.
    await expect(page.locator('[data-testid="cron-day-strip"]')).toBeVisible();
    expect(await page.locator('[data-testid="cron-month-grid"]').count()).toBe(0);
    const stripDay = await settledBox(page, '[data-testid="cron-day-strip"] button[aria-pressed]');
    expect(stripDay.height, 'a strip date is a full touch target').toBeGreaterThanOrEqual(44);
    expect(stripDay.width, 'a strip date is a full touch target').toBeGreaterThanOrEqual(44);

    await page.getByRole('button', { name: 'Date' }).click();
    await expect(page.locator('[data-slot="calendar"]')).toBeVisible();
    // Exactly ONE calendar is mounted: the chooser is the only place a month grid exists on a phone.
    expect(await page.locator('[data-slot="calendar"]').count()).toBe(1);
    const day = await settledBox(page, '[data-slot="calendar"] [role="grid"] button');
    expect(day.width, 'a mobile day target is a full touch target').toBeGreaterThanOrEqual(44);
    expect(day.height, 'a mobile day target is a full touch target').toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

// The cron workbench across the supported window sizes. Only cron-relevant properties are asserted:
// the declared measure, no horizontal overflow, and which of the two surfaces (month grid vs the
// agenda-first strip) the width is supposed to produce.
const VIEWPORTS = [
  { width: 1440, height: 900, grid: true },
  { width: 1280, height: 800, grid: true },
  { width: 1024, height: 768, grid: true },
  { width: 768, height: 1024, grid: true },
  { width: 390, height: 844, grid: false },
  { width: 320, height: 700, grid: false },
] as const;

for (const viewport of VIEWPORTS) {
  test(`the workbench fits ${viewport.width}x${viewport.height} without horizontal overflow`, async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench calendar');
    await seed.realPlugins();

    await app.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCalendar(app, '[data-testid="cron-calendar-body"]');
    await expect(app.locator('[data-page-measure]')).toHaveAttribute('data-page-measure', 'workbench');
    // `useMobile` is a width question below 768px, so the grid stands exactly where it should.
    expect(await app.locator('[data-testid="cron-month-grid"]').count(), 'month grid presence').toBe(viewport.grid ? 1 : 0);
    expect(await app.locator('[data-testid="cron-agenda"]').count(), 'the agenda is on every width').toBeGreaterThan(0);
    expect(
      await app.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `no horizontal overflow at ${viewport.width}px`,
    ).toBe(true);
  });
}
