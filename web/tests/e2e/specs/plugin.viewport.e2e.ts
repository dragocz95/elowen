// Layout guarantees for the pages plugins own — the `/p/*` surface.
//
// `viewport.e2e.ts` measures the same properties on the core pages. Everything under `/p/` used to be
// invisible to it: the fake daemon served an empty `/plugins/ui`, so a plugin page rendered the host's
// "this plugin is unavailable" notice and every register, toolbar, pager and takeover a plugin ships was
// asserted by nothing that runs a layout engine. `seed.realPlugins()` arms the listing with the REAL
// built bundles and `handlers/pluginSurfaces.ts` gives them content to lay out.
//
// WHICH PLUGINS ARE REACHABLE: the ones bundled in this repo (`plugins/`) always are. The plugin REGISTRY
// is a separate repository, so its pages are measured only when the run is pointed at that checkout with
// `E2E_PLUGIN_DIRS=/path/to/registry/plugins`; each case below skips what it does not find rather than
// asserting against a page that was never served. The properties are the same either way — they are
// properties of the plugin HOST and of the shared workspace kit, which is what a plugin composes.
import { test, expect, type Page } from '../fixtures/index.ts';
import { STORAGE_STATE } from '../../../playwright.config.ts';
import { EDITOR_PROJECT } from '../fake-daemon/handlers/pluginSurfaces.ts';

/** Core-bundled: always present, so a failure here is never "the checkout was set up differently". */
const CORE_PLUGINS = ['mcp', 'subagent'];
/** Registry-owned: measured when the run is pointed at the registry checkout, skipped otherwise. */
const REGISTRY_PLUGINS = ['stats', 'cronjob', 'skills', 'editor'];

/** The core register every plugin register must line up with. */
const REFERENCE_REGISTER = '/memory';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');

/** A page that reports a COARSE pointer, the way a phone does — see the note in `viewport.e2e.ts`:
 *  resizing alone leaves `pointer: fine`, and every touch-target rule is gated on the pointer. */
async function touchPage(browser: import('@playwright/test').Browser, size: { width: number; height: number }) {
  const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  return { context, page: await context.newPage() };
}

/** Open a plugin page and wait for the bundle to have painted its register. The host renders nothing at
 *  all while the listing and the bundle are in flight, so measuring without this reads an empty document. */
async function openPluginRegister(page: Page, plugin: string): Promise<void> {
  await page.goto(`/p/${plugin}`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('[role="table"] .data-table-header')).toBeVisible();
}

test('a plugin page draws exactly one page frame, the same one its sibling registers draw', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The defect: a settings section that renders its own WorkspaceShell was ALSO wrapped in the host's
  // WorkspacePage, so `/p/subagent` nested two page frames — the gutter and the bottom padding applied
  // twice and the page came out 41px narrower than every sibling register, with its hero 18px lower.
  // `ownsPageFrame` is what a bundle declares to stop that, and this is the measurement of it: the box
  // has to MATCH a core register, not merely be plausible.
  // Five viewports over every reachable plugin plus the reference register is ~35 navigations; the
  // default per-test budget is for a single-page case. The measurement is the point of this file, so it
  // gets the time rather than fewer widths — the boundary this defect lived on was width-dependent.
  test.setTimeout(240_000);
  const armed = await seed.realPlugins();
  const plugins = [...CORE_PLUGINS, ...REGISTRY_PLUGINS.filter((p) => p !== 'editor')].filter((p) => armed.includes(p));
  expect(plugins, 'no plugin bundle was reachable — the fixture served nothing to measure').not.toHaveLength(0);

  const frameBox = () => app.evaluate(() => {
    const shells = document.querySelectorAll('.workspace-shell');
    const box = shells[0]?.getBoundingClientRect();
    return {
      shells: shells.length,
      // The host's own page frame. A section that declares `ownsPageFrame` must get NONE of these; one
      // that does not declare it gets exactly one, and never one nested inside another.
      hostFrames: document.querySelectorAll('.workspace-page').length,
      x: box ? Math.round(box.x) : null,
      width: box ? Math.round(box.width) : null,
    };
  });

  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await app.setViewportSize(size);
    await app.goto(REFERENCE_REGISTER);
    await expect(app.locator('[role="table"] .data-table-header')).toBeVisible();
    const reference = await frameBox();
    expect(reference.shells, 'the reference register has a shell to compare against').toBe(1);

    for (const plugin of plugins) {
      await openPluginRegister(app, plugin);
      const measured = await frameBox();
      expect(measured.shells, `/p/${plugin} at ${size.width}px draws one page shell`).toBe(1);
      expect(measured.hostFrames + measured.shells, `/p/${plugin} at ${size.width}px nests page frames`).toBe(1);
      expect(measured.x, `/p/${plugin} starts where a core register starts at ${size.width}px`).toBe(reference.x);
      expect(measured.width, `/p/${plugin} is as wide as a core register at ${size.width}px`).toBe(reference.width);
    }
  }
});

test('the rows of a plugin register share one height', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // /p/skills measured 27/41/59/59/49px against the 48px rhythm every other register holds, which is
  // what makes a register unscannable. Its rows carry a mix of one-word and wrapping descriptions on
  // purpose (see the fixture) — that mix is exactly what produced the ragged heights.
  const armed = await seed.realPlugins();
  await app.setViewportSize({ width: 1440, height: 900 });
  for (const plugin of [...CORE_PLUGINS, 'stats', 'cronjob', 'skills'].filter((p) => armed.includes(p))) {
    await openPluginRegister(app, plugin);
    const heights = await app.evaluate(() =>
      [...document.querySelectorAll('[role="table"] [role="row"]:not(.data-table-header)')]
        .filter((row) => row.getAttribute('data-row-height') !== 'tall')
        .map((row) => Math.round(row.getBoundingClientRect().height)));
    expect(heights.length, `/p/${plugin} has rows to measure`).toBeGreaterThan(3);
    expect([...new Set(heights)], `every standard row of /p/${plugin} is the same height`).toHaveLength(1);
  }
});

test('no plugin toolbar overflows its own box', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // /p/skills ran 42px past its surface at 320px and clipped the last filter, because
  // `.control-surface-toolbar { align-items: center }` is UNLAYERED and beat the `items-stretch` utility
  // that was supposed to make the inner row fill the bar. The row then took its max-content width. It is
  // the same specificity trap that stopped the register header from sticking, and it is invisible at any
  // width where the labels happen to fit — which is why every narrow width is measured.
  const armed = await seed.realPlugins();
  const plugins = [...CORE_PLUGINS, ...REGISTRY_PLUGINS.filter((p) => p !== 'editor')].filter((p) => armed.includes(p));
  for (const width of [320, 390, 768, 1440]) {
    await app.setViewportSize({ width, height: 800 });
    for (const plugin of plugins) {
      await openPluginRegister(app, plugin);
      // Polled for the reason `viewport.e2e.ts` gives: the surface only reaches its real width once the
      // shell's container query resolves, and a toolbar measured before that reads as overflowing.
      await expect.poll(async () => app.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.control-surface-toolbar')]
          // A bar that scrolls is a deliberate strip, not a clipped one.
          .filter((bar) => bar.scrollWidth > bar.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(bar).overflowX))
          .map((bar) => `${bar.className} ${bar.scrollWidth}>${bar.clientWidth}`)),
      `/p/${plugin} at ${width}px`).toEqual([]);
    }
  }
});

test('a status-dot column is named for a screen reader and labelled once on screen', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // /p/mcp printed "Status" over TWO columns — the dot and the words — so the header row named the same
  // thing twice and neither label said which was which. The dot column keeps its accessible name and
  // gives up its visible one.
  const armed = await seed.realPlugins();
  test.skip(!armed.includes('mcp'), 'needs the mcp bundle');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openPluginRegister(app, 'mcp');

  const columns = await app.evaluate(() => [...document.querySelectorAll('.data-table-header [role="columnheader"]')].map((cell) => ({
    // The accessible name the host's DataTable publishes for a column.
    name: cell.getAttribute('title') ?? '',
    // `.sr-only` is the app's own visually-hidden convention: text present for assistive technology,
    // clipped to a pixel on screen.
    visuallyLabelled: cell.querySelector('.sr-only') === null && (cell as HTMLElement).innerText.trim() !== '',
  })));

  const status = columns.filter((column) => column.name === 'Status');
  expect(status.length, 'both the dot column and the words column are still named "Status"').toBe(2);
  expect(status.filter((column) => column.visuallyLabelled), 'only one of them prints that name').toHaveLength(1);
});

test("a plugin register's pager can be reached and used at 320px", async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  // The core pager's defect, on a plugin's page: laid out in a non-wrapping row it ran past the right
  // edge of an `overflow-x-hidden` main — painted, enabled, and impossible to tap.
  const armed = await seed.realPlugins();
  await seed.response('projects', [EDITOR_PROJECT]);
  const plugins = ['stats', 'cronjob', 'skills'].filter((p) => armed.includes(p));
  test.skip(plugins.length === 0, 'needs a registry bundle with a paginated register');

  const { context, page } = await touchPage(browser, { width: 320, height: 700 });
  try {
    for (const plugin of plugins) {
      await openPluginRegister(page, plugin);
      const next = page.getByRole('button', { name: /next page/i });
      await expect(next, `/p/${plugin} paginates its fixture rows`).toBeEnabled();
      const box = (await next.boundingBox())!;
      expect(box.x, `/p/${plugin} next starts inside the viewport`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `/p/${plugin} next ENDS inside the viewport`).toBeLessThanOrEqual(320);
      expect(box.height, `/p/${plugin} next is one touch target tall`).toBeGreaterThanOrEqual(44);

      const firstRow = page.locator('[role="row"]:not(.data-table-header)').first();
      const before = await firstRow.innerText();
      // No `force`: this tap has to succeed through real hit-testing, the way a finger's would.
      await next.click();
      await expect(firstRow).not.toHaveText(before);
    }
  } finally {
    await context.close();
  }
});

test('a plugin fullscreen surface is a takeover, not a hand-rolled overlay', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  // The editor's fullscreen used to be `fixed inset-0 z-50 h-screen`: `h-screen` measures `vh`, so the
  // file toolbar sat under a phone browser's chrome; z-50 tied with the nav drawer, the advisor launcher
  // and the toasts; and the only exit was an unlabelled 28px chevron. WorkspaceTakeover owns all of it.
  const armed = await seed.realPlugins();
  test.skip(!armed.includes('editor'), 'needs the editor bundle');
  await seed.response('projects', [EDITOR_PROJECT]);

  const size = { width: 390, height: 844 };
  const { context, page } = await touchPage(browser, size);
  try {
    // The editor auto-fullscreens on a phone, so the takeover is what the page IS here — there is no
    // control to press first, which is precisely why an exit that is not reachable traps the user.
    await page.goto('/p/editor');
    const takeover = page.locator('[data-elowen-takeover]');
    await expect(takeover).toBeVisible();
    await expect(takeover).toHaveAttribute('role', 'dialog');
    await expect(takeover).toHaveAttribute('aria-modal', 'true');

    const measured = await takeover.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const launcher = document.querySelector('.overlay-fab');
      const toast = document.querySelector('.overlay-toast-dock');
      return {
        height: Math.round(box.height), top: Math.round(box.top),
        // The layer's z-index, read from the shared scale rather than a literal in the plugin.
        layer: Number(getComputedStyle(el.parentElement!).zIndex),
        launcher: launcher ? Number(getComputedStyle(launcher).zIndex) : null,
        toast: toast ? Number(getComputedStyle(toast).zIndex) : null,
        focusInside: el.contains(document.activeElement),
      };
    });

    // It resolves against the VISIBLE viewport. A `vh` height would overshoot by whatever a collapsing
    // mobile toolbar is worth, putting the surface's own bottom toolbar off screen.
    expect(measured.top, 'the takeover starts at the top of the screen').toBe(0);
    expect(measured.height, 'the takeover ends at the bottom of the screen').toBe(size.height);
    // Above the advisor launcher, which used to paint straight through it.
    expect(measured.launcher, 'the advisor launcher sits below the takeover').toBeLessThan(measured.layer);
    // A toast still has to reach the user over a surface that owns the screen — that one is deliberate.
    expect(measured.toast, 'a toast still outranks the takeover').toBeGreaterThan(measured.layer);

    const back = takeover.getByRole('button').first();
    await expect(back, 'the exit has an accessible name').not.toHaveAttribute('aria-label', '');
    const backBox = (await back.boundingBox())!;
    expect(backBox.height, 'the exit meets the touch floor').toBeGreaterThanOrEqual(44);
    expect(backBox.width).toBeGreaterThanOrEqual(44);

    // Focus is trapped: it moved in on open, and tabbing cannot walk out into the inert page behind.
    expect(measured.focusInside, 'focus moves into the takeover').toBe(true);
    for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
    expect(await takeover.evaluate((el) => el.contains(document.activeElement)), 'focus stays inside the takeover').toBe(true);

    await page.keyboard.press('Escape');
    await expect(takeover).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('every plugin page is unscaled, unscrolled sideways, and names itself once', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The same three invariants `viewport.e2e.ts` holds for the core pages. A plugin page is reached
  // through the same shell and inherits the same defects when they come back.
  test.setTimeout(240_000); // same reason as the page-frame case: many navigations, not a slow one.
  const armed = await seed.realPlugins();
  await seed.response('projects', [EDITOR_PROJECT]);
  const plugins = [...CORE_PLUGINS, ...REGISTRY_PLUGINS].filter((p) => armed.includes(p));

  for (const width of [320, 390, 768, 1440]) {
    await app.setViewportSize({ width, height: 900 });
    for (const plugin of plugins) {
      await app.goto(`/p/${plugin}`);
      await expect(app.locator('h1'), `/p/${plugin} at ${width}px names itself exactly once`).toHaveCount(1);
      await expect(app.locator('h1')).not.toBeEmpty();
      const measured = await app.evaluate(() => ({
        zoom: getComputedStyle(document.documentElement).zoom,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      // Nothing in the layout may rescale the app; that width-driven `zoom` is the original defect.
      expect(measured.zoom, `zoom on /p/${plugin} at ${width}px`).toBe('1');
      expect(measured.scrollWidth, `/p/${plugin} overflows horizontally at ${width}px`).toBeLessThanOrEqual(measured.clientWidth);
    }
  }
});
