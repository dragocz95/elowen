import { test, expect } from '@playwright/test';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

async function openFromChat(page: import('@playwright/test').Page) {
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  const sidebar = page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();
  await sidebar.locator('button').filter({ hasText: 'Settings' }).click();
  await sidebar.locator('a[href="/settings?cat=system"]').click();
  await expect(page).toHaveURL(/\/settings\?cat=/);
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
    const content = node.querySelector('[data-testid="settings-overlay-layout"] > section')!.getBoundingClientRect();
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
  expect(geometry.nav.width).toBeGreaterThan(240);
  expect(geometry.content.x).toBeGreaterThan(geometry.nav.x + geometry.nav.width - 2);

  await page.getByRole('button', { name: /^Models/ }).click();
  await expect(page).toHaveURL('/settings?cat=models');
  await page.goBack();
  await expect(page).toHaveURL('/chat');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
});

test('Settings refreshes as the canonical full page', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await openFromChat(page);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(page.locator('[data-module="settings"]')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\?cat=/);
});

test('the phone overlay uses one full-screen pane without nested scrolling', async ({ page }, testInfo) => {
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

  await dialog.getByRole('button', { name: 'All settings' }).click();
  await expect(dialog.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1 })).toBeHidden();

  const scrolling = await dialog.evaluate((node) => {
    const visiblePanes = [...node.querySelectorAll<HTMLElement>('[data-testid="settings-overlay-layout"] > aside, [data-testid="settings-overlay-layout"] > section')]
      .filter((pane) => getComputedStyle(pane).display !== 'none');
    return {
      visiblePanes: visiblePanes.length,
      bodyOverflow: getComputedStyle(document.body).overflow,
      paneOverflow: visiblePanes.map((pane) => getComputedStyle(pane).overflowY),
    };
  });
  expect(scrolling.visiblePanes).toBe(1);
  expect(scrolling.bodyOverflow).toBe('hidden');
  expect(scrolling.paneOverflow).toEqual(['visible']);
});
