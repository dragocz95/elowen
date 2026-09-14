import { test, expect } from '@playwright/test';

/** THE NAVIGATION COLUMN'S CONTRACT, stated here because this is the only check that measures it against a
 *  real browser rather than against a class name.
 *
 *  `SettingsView` declares the overlay's first grid track as `15rem`, which is 240px at the app's 16px
 *  root. The assertion is an intentional TOLERANCE rather than an equality: the track is a grid column
 *  whose rendered box picks up the aside's border on one side, and a platform that reserves a scrollbar
 *  gutter inside the column takes a few pixels more. A hard `toBe(240)` would fail on those platforms for
 *  a reason that has nothing to do with the design decision, and the previous `toBeGreaterThan(240)` was
 *  a one-sided bound that a column of any width above it would satisfy — it passed the 18rem column this
 *  replaced and would pass a 30rem one. The band is what actually holds the decision. */
const NAV_COLUMN_PX = 240;
const NAV_COLUMN_TOLERANCE_PX = 8;

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

async function openFromChat(page: import('@playwright/test').Page) {
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  const sidebar = page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();
  // One row for the deck: the column opens Settings, and Settings navigates its own sections.
  await sidebar.locator('a[href="/settings"]').click();
  await expect(page).toHaveURL(/\/settings/);
  return page.getByRole('dialog', { name: 'Settings' });
}

test('Settings intercepts navigation over chat and keeps canonical history', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await openFromChat(page);
  await expect(dialog).toBeVisible();
  await expect(page.locator('[data-module="chat"]')).toBeAttached();

  const geometry = await dialog.evaluate((node) => {
    const dialogBox = node.getBoundingClientRect();
    const nav = node.querySelector('nav[aria-label]')!.getBoundingClientRect();
    const content = node.querySelector('[data-testid="settings-deck-layout"] > section')!.getBoundingClientRect();
    return {
      dialog: { x: dialogBox.x, y: dialogBox.y, width: dialogBox.width, height: dialogBox.height },
      nav: { x: nav.x, width: nav.width },
      content: { x: content.x, width: content.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(geometry.dialog.width).toBeLessThan(geometry.viewport.width - 24);
  expect(geometry.dialog.height).toBeLessThan(geometry.viewport.height - 24);
  expect(Math.abs(geometry.dialog.x * 2 + geometry.dialog.width - geometry.viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.dialog.y * 2 + geometry.dialog.height - geometry.viewport.height)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.nav.width - NAV_COLUMN_PX)).toBeLessThanOrEqual(NAV_COLUMN_TOLERANCE_PX);
  expect(geometry.content.x).toBeGreaterThan(geometry.nav.x + geometry.nav.width - 2);

  // Dispatched on the row itself: every record carries its own help anchor, whose expanded hit area
  // covers the row and swallows a positional click. What this test is about is the history the row
  // writes, not where a pointer lands on it.
  await page.locator('[data-testid="settings-navigation-sidebar"]')
    .getByRole('button', { name: 'Models', exact: true })
    .evaluate((row) => (row as HTMLElement).click());
  await expect(page).toHaveURL('/settings?cat=models');
  await page.goBack();
  await expect(page).toHaveURL('/chat');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

/** THE SAME PRESENTATION ON EVERY ARRIVAL. Interception answers a client navigation and nothing else, so
 *  a refresh used to fall through to a standalone page: the same address wearing a different product. */
test('Settings refreshes as the same overlay', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await openFromChat(page);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?cat=/);
});

/** THE FLASH. A client navigation used to have two route trees answering for one screen — the canonical
 *  page and the interceptor — so the standalone deck could paint for a frame before the overlay replaced
 *  it. The canonical page draws nothing now, so there is no frame of standalone content to catch: the
 *  deck only ever exists INSIDE the dialog, sampled every frame from the click until the overlay is up. */
test('a client navigation never paints a standalone Settings before the overlay', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  const sidebar = page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();

  await page.evaluate(() => {
    const counter = window as unknown as { __strayDecks: number };
    counter.__strayDecks = 0;
    const sample = () => {
      counter.__strayDecks += [...document.querySelectorAll('[data-testid="settings-deck-layout"]')]
        .filter((deck) => !deck.closest('[data-elowen-modal]')).length;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });

  await sidebar.locator('a[href="/settings"]').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __strayDecks: number }).__strayDecks)).toBe(0);
});

test('a cold load opens the overlay, with no standalone page behind it', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings?cat=models');

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(page.locator('[data-module="settings"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-deck-layout"]')).toHaveCount(1);

  // Back and forward keep answering with the overlay rather than with a page.
  await page.goto('/dash');
  await expect(page.locator('[data-module="dashboard"]')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(page.locator('[data-module="dashboard"]')).toBeVisible();
});

test('the phone overlay is one full-screen pane navigated by a persistent section strip', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await openFromChat(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
  const box = (await dialog.boundingBox())!;
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.width)).toBe(390);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);

  // The strip is the phone's whole navigation: it stays on screen with the content instead of the content
  // being traded away for a category list, and the column is simply not rendered at this width.
  const strip = dialog.getByTestId('settings-navigation-tabs');
  await expect(strip).toBeVisible();
  await expect(dialog.getByRole('searchbox', { name: 'Search settings' })).toBeHidden();

  const scrolling = await dialog.evaluate((node) => {
    const visiblePanes = [...node.querySelectorAll<HTMLElement>('[data-testid="settings-deck-layout"] > aside, [data-testid="settings-deck-layout"] > section')]
      .filter((pane) => getComputedStyle(pane).display !== 'none');
    const track = node.querySelector<HTMLElement>('[data-testid="settings-navigation-tabs"]')!;
    return {
      visiblePanes: visiblePanes.length,
      bodyOverflow: getComputedStyle(document.body).overflow,
      // ONE scroller: the content pane. The strip scrolls sideways only, so nothing nests a second
      // vertical scroll inside the screen the reader is already scrolling.
      paneOverflow: visiblePanes.map((pane) => getComputedStyle(pane).overflowY),
      // NOT `getComputedStyle(track).overflowY`: a box with `overflow-x: auto` computes its other axis to
      // `auto` too, by the CSS rule that a non-visible overflow on one axis forces the other. Whether the
      // strip can actually be scrolled vertically is the question, and only its geometry answers it.
      stripScrollsVertically: track.scrollHeight > track.clientHeight,
      // The line runs off its own edge rather than off the dialog's.
      stripWithinDialog: track.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1,
      documentOverflowsHorizontally: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  expect(scrolling.visiblePanes).toBe(1);
  expect(scrolling.bodyOverflow).toBe('hidden');
  expect(scrolling.paneOverflow).toEqual(['auto']);
  expect(scrolling.stripScrollsVertically).toBe(false);
  expect(scrolling.stripWithinDialog).toBe(true);
  expect(scrolling.documentOverflowsHorizontally).toBe(false);

  // Moving between two sections is one tap, and the section just opened is still on screen.
  await strip.getByRole('button', { name: 'Models' }).click();
  await expect(page).toHaveURL('/settings?cat=models');
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Models' })).toHaveAttribute('aria-current', 'page');
});
