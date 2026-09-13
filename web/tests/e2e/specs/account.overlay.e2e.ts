import { test, expect, type Locator, type Page } from '@playwright/test';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

/** The primary navigation, opened first where it is a sheet (a phone) rather than a column. */
async function openSidebar(page: Page): Promise<Locator> {
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  return page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();
}

/** Disclose a deck's sections in the column. The route opens its own parent, so a click there would fold
 *  it shut instead. */
async function discloseSections(sidebar: Locator, deck: string): Promise<void> {
  const disclosure = sidebar.locator('button').filter({ hasText: deck }).first();
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
}

const accountOverlay = (page: Page) => page.getByRole('dialog', { name: 'My account' });

async function openFromChat(page: Page): Promise<Locator> {
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const sidebar = await openSidebar(page);
  await discloseSections(sidebar, 'Account');
  await sidebar.locator('a[href="/account?cat=profile"]').click();
  await expect(page).toHaveURL(/\/account\?cat=/);
  return accountOverlay(page);
}

test('Account intercepts navigation over chat and keeps canonical history', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await openFromChat(page);
  await expect(dialog).toBeVisible();
  // The page it was opened over stays mounted underneath, which is what makes this an overlay rather
  // than a route change that happens to look like one.
  await expect(page.locator('[data-module="chat"]')).toBeAttached();

  const geometry = await dialog.evaluate((node) => {
    const dialogBox = node.getBoundingClientRect();
    const nav = node.querySelector('[data-testid="account-navigation-sidebar"]')!.getBoundingClientRect();
    const content = node.querySelector('[data-testid="account-overlay-layout"] > section')!.getBoundingClientRect();
    return {
      dialog: { x: dialogBox.x, y: dialogBox.y, width: dialogBox.width, height: dialogBox.height },
      nav: { x: nav.x, width: nav.width },
      content: { x: content.x, width: content.width },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  // The same centered desktop frame Settings uses.
  expect(geometry.dialog.width).toBeLessThan(geometry.viewport.width - 24);
  expect(geometry.dialog.height).toBeLessThan(geometry.viewport.height - 24);
  expect(Math.abs(geometry.dialog.x * 2 + geometry.dialog.width - geometry.viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.dialog.y * 2 + geometry.dialog.height - geometry.viewport.height)).toBeLessThanOrEqual(2);
  // The secondary column sits beside the content, not over it.
  expect(geometry.nav.width).toBeGreaterThan(240);
  expect(geometry.content.x).toBeGreaterThan(geometry.nav.x + geometry.nav.width - 2);

  await dialog.getByRole('button', { name: 'Security' }).click();
  await expect(page).toHaveURL('/account?cat=security');
  // The section moved inside the overlay that was already up: no second one over it, and the page it was
  // opened from is still the surface underneath.
  await expect(accountOverlay(page)).toHaveCount(1);
  await expect(page.locator('[data-module="chat"]')).toBeAttached();
  // A section switch replaced the entry, so one Back leaves the overlay entirely.
  await page.goBack();
  await expect(page).toHaveURL('/chat');
  await expect(accountOverlay(page)).toHaveCount(0);
});

test('Account refreshes as the canonical full page', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await openFromChat(page);
  await page.reload();
  await expect(accountOverlay(page)).toHaveCount(0);
  await expect(page.locator('[data-module="account"]')).toBeVisible();
  await expect(page).toHaveURL(/\/account\?cat=/);
});

/** THE CANONICAL PAGE ANSWERS ITS OWN SECTION ROWS.
 *
 *  Interception answers a client navigation whatever surface it was made from — the canonical page
 *  included. A section row clicked here therefore has to move the page the reader is looking at, not
 *  raise a second Account in an overlay above it. The shell states that once (ShellLink): a navigation to
 *  the pathname the document is already on is announced in the document instead of routed. */
test('a section row on the hard-loaded page changes the section without opening an overlay', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account?cat=profile');
  await expect(page.locator('[data-module="account"]')).toBeVisible();

  const sidebar = await openSidebar(page);
  await discloseSections(sidebar, 'Account');
  await sidebar.locator('a[href="/account?cat=security"]').click();

  await expect(page).toHaveURL('/account?cat=security');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-module="account"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  // The row the address names is the one the column marks, on this page as in the overlay.
  await expect(sidebar.locator('a[href="/account?cat=security"]')).toHaveAttribute('aria-current', 'page');
});

test('Account opens from the identity in the top bar and gives focus back on close', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();

  const identity = page.locator('.top-bar__identity');
  await identity.click();
  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/account/);
  await expect(page.locator('[data-module="chat"]')).toBeAttached();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(accountOverlay(page)).toHaveCount(0);
  await expect(page).toHaveURL('/chat');
  // The reader is put back where they were, not at the top of the document.
  await expect(identity).toBeFocused();
});

test('Account opens from the command palette', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();

  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.getByRole('dialog', { name: 'Open command palette' }).getByPlaceholder('Search…').fill('Security');
  await page.locator('[cmdk-item][data-value="account:security"]').click();

  await expect(page).toHaveURL('/account?cat=security');
  await expect(accountOverlay(page)).toBeVisible();
  await expect(page.locator('[data-module="chat"]')).toBeAttached();
});

test('Settings opens Account as an overlay over it, without leaving the settings page', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings?cat=models');
  await expect(page.locator('[data-module="settings"]')).toBeVisible();

  const sidebar = await openSidebar(page);
  await discloseSections(sidebar, 'Account');
  await sidebar.locator('a[href="/account?cat=cli"]').click();

  await expect(page).toHaveURL('/account?cat=cli');
  await expect(accountOverlay(page)).toBeVisible();
  // Settings is the surface underneath, and it stayed a page rather than becoming a second overlay.
  await expect(page.locator('[data-module="settings"]')).toBeAttached();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

test('Back leaves the overlay and Forward brings the same one back', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFromChat(page);
  await expect(accountOverlay(page)).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL('/chat');
  await expect(accountOverlay(page)).toHaveCount(0);
  // The surface that was underneath is a whole page again — not an empty shell where the overlay was.
  await expect(page.locator('[data-module="chat"]')).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/account\?cat=/);
  await expect(accountOverlay(page)).toBeVisible();
  await expect(page.locator('[data-module="chat"]')).toBeAttached();
});

/** A parallel slot keeps whatever it last matched, so `app/@pageOverlay/[...catchAll]` is what takes the
 *  overlay off an unrelated route. Reached the way a reader reaches it: the overlay is left through
 *  history, and the next destination is an ordinary page of the menu. */
test('an unrelated route never keeps the page overlay', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openFromChat(page);
  await expect(accountOverlay(page)).toBeVisible();
  await page.goBack();
  await expect(accountOverlay(page)).toHaveCount(0);

  const sidebar = await openSidebar(page);
  await sidebar.locator('a[href="/dash"]').first().click();
  await expect(page).toHaveURL('/dash');
  await expect(page.locator('[data-module="dashboard"]')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-testid="account-overlay"]')).toHaveCount(0);
});

test('the phone overlay is one full-screen pane with a single line of tabs', async ({ page }, testInfo) => {
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

  const phoneNavigation = await dialog.evaluate((node) => {
    const tabs = node.querySelector<HTMLElement>('[data-testid="account-navigation-tabs"]')!;
    const sidebar = node.querySelector<HTMLElement>('[data-testid="account-navigation-sidebar"]')!;
    const rows = [...tabs.querySelectorAll<HTMLElement>('button')].map((button) => button.getBoundingClientRect().top);
    return {
      tabsVisible: getComputedStyle(tabs).display !== 'none',
      sidebarVisible: sidebar.getBoundingClientRect().width > 0,
      // One line: every tab shares a top edge, however many of them there are.
      distinctRows: new Set(rows.map((top) => Math.round(top))).size,
      scrolls: getComputedStyle(tabs).overflowX,
    };
  });
  expect(phoneNavigation.tabsVisible).toBe(true);
  expect(phoneNavigation.sidebarVisible).toBe(false);
  expect(phoneNavigation.distinctRows).toBe(1);
  expect(phoneNavigation.scrolls).toBe('auto');
});

/** A section near the end of the strip is off to the right of a 390px screen. Arriving on it — from the
 *  menu, from a link, from the section this browser remembers — has to bring its tab into view, on the
 *  horizontal axis alone. */
test('a section at the end of the phone tab strip is scrolled into view on arrival', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const sidebar = await openSidebar(page);
  await discloseSections(sidebar, 'Account');
  await sidebar.locator('a[href="/account?cat=terminal"]').click();

  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL('/account?cat=terminal');

  const strip = await dialog.locator('[data-testid="account-navigation-tabs"]').evaluate((track) => {
    const item = track.querySelector<HTMLElement>('[aria-current="page"]')!;
    const trackBox = track.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    return {
      label: item.textContent,
      scrollLeft: track.scrollLeft,
      pageScrollTop: document.scrollingElement?.scrollTop ?? 0,
      within: itemBox.left >= trackBox.left - 1 && itemBox.right <= trackBox.right + 1,
    };
  });
  expect(strip.label).toContain('Terminal');
  expect(strip.within).toBe(true);
  // It really had to travel: the last of seven tabs does not fit on a 390px line.
  expect(strip.scrollLeft).toBeGreaterThan(0);
  // …and the strip moved, not the pane behind it.
  expect(strip.pageScrollTop).toBe(0);
});
