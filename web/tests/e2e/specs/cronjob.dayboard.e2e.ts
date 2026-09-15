// The cronjob plugin's DAY BOARD, exercised against the REAL registry bundle.
//
// The cron page is a day planner — an hour gutter, a band per hour, a block in the band it runs in and
// a now line — with a separate lane for jobs that run on a rate. It replaced a month calendar that, on
// a real instance, drew between 455 and 1253 occurrence rows for a single day and took seconds to
// arrive. So the measurements here are the ones that redesign has to keep true in a real engine:
//   - the page is FRAMED like every other workbench (`data-page-measure`, one frame);
//   - the day reads as a DAY: labelled hour bands, blocks inside them, a now marker;
//   - a two-minute poll is ONE row, not 720 — the DOM is bounded whatever the schedule is;
//   - the surface reaches content quickly, behind a real skeleton;
//   - the `Other day` chooser is the host's real shadcn Calendar (react-day-picker beneath it), with
//     the keyboard navigation that grid owns and a coarse-pointer touch floor on a date;
//   - the drawer opens from a block and returns focus to it.
// The plugin's own recurrence engine is asserted in its own repository; here it must LOOK integrated
// and BEHAVE like a real planner.
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
async function openBoard(page: Page, wait = '[data-testid="cron-day-rail"]'): Promise<void> {
  await page.goto('/p/cronjob');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator(wait)).toBeVisible();
}

/** Open the `Other day` chooser and return its grid. The board keeps the real month calendar in
 *  exactly one place — choosing a date — which is the one thing a calendar is genuinely best at. */
async function openDayPicker(page: Page) {
  await page.getByRole('button', { name: /other day/i }).click();
  const grid = page.locator('[data-slot="calendar"] [role="grid"]');
  await expect(grid).toBeVisible();
  return grid;
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

test('the day board is framed at the workbench measure, with one frame and no register', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout with the API 17 day board built');
  const armed = await seed.realPlugins();
  expect(armed.includes('cronjob'), 'the workbench checkout exists but the harness did not arm the cronjob bundle').toBe(true);

  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);
  const frame = app.locator('[data-page-measure]');
  await expect(frame).toHaveAttribute('data-page-measure', 'workbench');
  expect(await frame.count()).toBe(1);
  // One frame, not two: the plugin owns its surface under `WorkspacePage`/`WorkspaceHero`, and the
  // host adds no second page column (or a register-style WorkspaceShell) around a workbench page.
  expect(await app.evaluate(() => document.querySelectorAll('.workspace-shell').length
    + document.querySelectorAll('[data-page-measure]').length)).toBe(1);
  // No table anywhere: the day is drawn, not tabulated. The month grid is behind `Other day`.
  expect(await app.locator('table').count(), 'no register table on the board').toBe(0);
  expect(await app.locator('[data-slot="calendar"]').count(), 'no month grid on the board itself').toBe(0);
});

test('the day reads as a DAY: an hour gutter, bands, blocks inside them and a now marker', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);

  const rail = app.locator('[data-testid="cron-day-rail"]');
  // A labelled band per hour the day spans, INCLUDING the empty ones — that is the difference between
  // a planner and a list with headings, and it is exactly what a reader recognises at a glance.
  const bands = rail.locator('> div');
  expect(await bands.count()).toBeGreaterThanOrEqual(6);
  const gutter = await rail.evaluate((node) => [...node.children]
    .map((band) => band.firstElementChild?.textContent?.trim() ?? ''));
  expect(gutter.every((label) => /^\d{2}:00$/.test(label)), `hour gutter reads ${gutter.join(',')}`).toBe(true);
  // Consecutive hours, nothing skipped: a band is a position in the day, not a group header.
  const hours = gutter.map((label) => Number(label.slice(0, 2)));
  expect(hours).toEqual(hours.map((_, i) => hours[0]! + i));

  // Each block sits INSIDE its hour band, vertically ordered by time.
  const blocks = rail.locator('[data-testid^="cron-row-"]');
  expect(await blocks.count()).toBeGreaterThan(0);
  const misplaced = await rail.evaluate((node) => {
    const bad: string[] = [];
    for (const band of node.children) {
      const hour = band.firstElementChild?.textContent?.trim().slice(0, 2);
      for (const block of band.querySelectorAll('[data-testid^="cron-row-"]')) {
        const time = block.querySelector('span')?.textContent?.trim().slice(0, 2);
        if (hour !== time) bad.push(`${block.getAttribute('data-testid')}: ${time} in ${hour}`);
      }
    }
    return bad;
  });
  expect(misplaced, 'every block belongs to the hour band it is drawn in').toEqual([]);

  // The present moment, marked on the rail where a planner marks it.
  const now = app.locator('[data-testid="cron-now-line"]');
  await expect(now).toHaveCount(1);
  const inside = await now.evaluate((line) => {
    const band = line.closest('[data-testid^="cron-hour-"]');
    return band?.getAttribute('data-testid') ?? '';
  });
  expect(inside).toMatch(/^cron-hour-\d{2}$/);
});

test('a two-minute poll is ONE row, and the DOM stays bounded whatever the schedule is', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);

  // THE regression. The retired month view drew a row per occurrence and produced 455 to 1253 of them
  // for a single day on this instance's real schedules. Here the same 720-runs-a-day poll is one row.
  const rows = app.locator('[data-testid^="cron-row-"]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  expect(count, 'one row per job, never one per run').toBeLessThan(20);
  const ids = await rows.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid')));
  expect(new Set(ids).size, 'no job is drawn twice').toBe(ids.length);

  // The poll is described by its RATE in the recurring lane, and is not on the timed rail where it
  // would bury every real appointment.
  const lane = app.locator('[data-testid="cron-recurring-lane"]');
  await expect(lane.locator('[data-testid="cron-row-job-poll"]')).toHaveCount(1);
  await expect(lane).toContainText('every 2m');
  await expect(app.locator('[data-testid="cron-day-rail"] [data-testid="cron-row-job-poll"]')).toHaveCount(0);

  // And the whole page stays small: an occurrence explosion shows up as element count long before it
  // shows up as a visibly broken layout.
  const elements = await app.evaluate(() => document.querySelectorAll('[data-page-measure] *').length);
  expect(elements, `the board rendered ${elements} elements`).toBeLessThan(1_500);
});

test('the board reaches content quickly, behind a real loading state', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });

  // Hold the day response back just long enough to see what the page shows while it waits: a real
  // skeleton, not an empty frame and not a spinner over stale content.
  await app.route('**/plugins/cronjob/api/day**', async (route) => {
    await new Promise((done) => setTimeout(done, 700));
    await route.continue();
  });
  const started = Date.now();
  await app.goto('/p/cronjob');
  await expect(app.locator('h1')).toBeVisible();
  // The host's own LoadingState: a skeleton shaped like the content, announced with `aria-busy`.
  await expect(app.locator('[data-page-measure] [aria-busy="true"]').first())
    .toBeVisible({ timeout: 5_000 });
  await app.unroute('**/plugins/cronjob/api/day**');

  await expect(app.locator('[data-testid="cron-day-rail"]')).toBeVisible({ timeout: 10_000 });
  const elapsed = Date.now() - started;
  // Generous, because it includes the artificial 700ms and a cold bundle load. It is still an order of
  // magnitude under the seconds the month view took, which is the number that mattered.
  expect(elapsed, `the board took ${elapsed}ms to reach content`).toBeLessThan(8_000);
});

test('the month grid survives in ONE place: the Other day chooser, as the runtime Calendar', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);

  const grid = await openDayPicker(app);
  // The grid semantics come from the host Calendar (`data-slot="calendar"` is the shadcn Root marker
  // the runtime primitive sets), never from a hand-rolled table — and there is exactly one of it.
  expect(await app.evaluate(() => document.querySelectorAll('[data-slot="calendar"] [role="grid"]').length)).toBe(1);
  const weekdayLabels = await app.evaluate(() => {
    const headers = document.querySelectorAll('[data-slot="calendar"] thead th');
    return headers.length === 7 ? 'th'
      : document.querySelectorAll('[data-slot="calendar"] colgroup col').length === 7 ? 'col' : 'none';
  });
  expect(weekdayLabels !== 'none', `the runtime Calendar rendered no weekday labels (shape: ${weekdayLabels})`).toBe(true);
  const named = await app.evaluate(() => [...document.querySelectorAll('[data-slot="calendar"] [role="grid"] button')]
    .every((button) => (button.getAttribute('aria-label') ?? '').length > 0));
  expect(named, 'every day button carries an accessible name').toBe(true);
  void grid;
});

test('the chooser stays the size of a calendar inside a wide window', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);
  const grid = await openDayPicker(app);

  // The host Calendar fills whatever box it is handed, so a month in a full-width dialog becomes a
  // wall of enormous empty cells. A date picker has a natural size and has to keep it.
  const width = (await grid.boundingBox())!.width;
  expect(width, `the chooser grid measured ${width}px wide in a 1440px window`).toBeLessThan(560);
  const cell = (await grid.locator('[role="gridcell"], td').first().boundingBox())!;
  expect(cell.height, `a day cell measured ${cell.height}px tall`).toBeLessThan(80);
});

test('every block on the day is reachable by scrolling, including the last hour', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);

  // A rail taller than the viewport is normal for a day; a rail whose bottom cannot be reached is a
  // job nobody can open. The last block has to scroll into view and take a click.
  const last = app.locator('[data-testid="cron-day-rail"] [data-testid^="cron-row-"]').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await last.click();
  await expect(app.locator('[role="dialog"]').first()).toBeVisible();
});

test('the chooser keeps react-day-picker own keyboard navigation', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);
  await openDayPicker(app);

  const focusedDay = () => app.evaluate(() => document.activeElement?.closest('td,[role="gridcell"]')
    ?.getAttribute('data-day') ?? document.activeElement?.getAttribute('aria-label') ?? '');
  // The board hands the library an unmodified Calendar, so the arrows, Home/End and PageUp are the
  // library's own — and a plugin can no longer break them by overriding the day button.
  await app.locator('[data-slot="calendar"] [role="grid"] button[tabindex="0"]').first().focus();
  const start = await focusedDay();
  expect(start.length).toBeGreaterThan(0);
  for (const key of ['ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp']) {
    const before = await focusedDay();
    await app.keyboard.press(key);
    const after = await focusedDay();
    expect(after, `${key} moved focus`).not.toBe(before);
  }
});

test('a block opens the job drawer and gives focus back when it closes', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  await openBoard(app);

  const block = app.locator('[data-testid="cron-day-rail"] [data-testid^="cron-row-"]').first();
  const id = await block.getAttribute('data-testid');
  await block.click();
  const dialog = app.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // The host Modal's own contract: focus returns to the control that raised it, so a keyboard reader
  // is not dropped at the top of the document.
  await expect(app.locator(`[data-testid="${id}"]`)).toBeFocused();
});

test('a date in the chooser clears the coarse-pointer touch floor', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();

  // The touch floor is a `(pointer: coarse)` rule, and the harness runs Desktop Chrome — where that
  // query NEVER matches, whatever the viewport is. Emulating a phone's metrics is what puts the
  // browser in coarse-pointer mode, so this measures the rule instead of measuring around it.
  const cdp = await app.context().newCDPSession(app);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await openBoard(app);
  expect(await app.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
    'the harness is in coarse-pointer mode').toBe(true);
  await openDayPicker(app);

  const selector = '[data-slot="calendar"] [role="grid"] button';
  const box = await settledBox(app, selector);
  // Measured AFTER the overlay's zoom settles: a box sampled mid-animation reads ~43.1px for an
  // element whose layout size is exactly 44.
  expect(box.height, `a date measured ${box.height}px tall`).toBeGreaterThanOrEqual(44);
  expect(box.width, `a date measured ${box.width}px wide`).toBeGreaterThanOrEqual(44);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
});

test('a block on a phone clears the touch floor too', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
  await seed.realPlugins();
  await app.setViewportSize({ width: 390, height: 844 });
  await openBoard(app);
  // The phone gets the SAME planner, and every block on it is a real finger target.
  const box = await settledBox(app, '[data-testid="cron-day-rail"] [data-testid^="cron-row-"]');
  expect(box.height, `a block measured ${box.height}px tall`).toBeGreaterThanOrEqual(44);
});

for (const { width, height } of [
  { width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 },
  { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 700 },
]) {
  test(`the board fits ${width}x${height} without horizontal overflow`, async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    test.skip(!workbenchCronjob(), 'needs a registry checkout that declares the workbench day board');
    await seed.realPlugins();
    await app.setViewportSize({ width, height });
    await openBoard(app);
    const overflow = await app.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      wide: [...document.querySelectorAll('[data-page-measure] *')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible')
        .map((node) => node.getAttribute('data-testid') ?? node.className).slice(0, 4),
    }));
    expect(overflow.doc, `document overflows by ${overflow.doc}px`).toBeLessThanOrEqual(1);
    expect(overflow.wide, 'no element scrolls sideways without saying so').toEqual([]);
  });
}
