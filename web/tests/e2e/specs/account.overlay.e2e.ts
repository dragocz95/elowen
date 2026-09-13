import { test, expect } from '@playwright/test';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

async function openFromChat(page: import('@playwright/test').Page) {
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  const sidebar = page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();
  await sidebar.locator('button').filter({ hasText: 'Account' }).first().click();
  await sidebar.locator('a[href="/account?cat=profile"]').click();
  await expect(page).toHaveURL(/\/account\?cat=/);
  return page.getByRole('dialog', { name: 'My account' });
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
  // A section switch replaced the entry, so one Back leaves the overlay entirely.
  await page.goBack();
  await expect(page).toHaveURL('/chat');
  await expect(page.getByRole('dialog', { name: 'My account' })).toHaveCount(0);
});

test('Account refreshes as the canonical full page', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await openFromChat(page);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'My account' })).toHaveCount(0);
  await expect(page.locator('[data-module="account"]')).toBeVisible();
  await expect(page).toHaveURL(/\/account\?cat=/);
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
