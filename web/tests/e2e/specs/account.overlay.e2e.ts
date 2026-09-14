import { test, expect, type Locator, type Page } from '@playwright/test';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

/** The primary navigation, opened first where it is a sheet (a phone) rather than a column. */
async function openSidebar(page: Page): Promise<Locator> {
  const menu = page.getByRole('button', { name: 'Toggle menu' });
  if (await menu.isVisible()) await menu.click();
  return page.locator('[data-shell="sidebar"][data-open="true"], [data-shell="sidebar"]:not([data-mode="drawer"])').first();
}

const accountOverlay = (page: Page) => page.getByRole('dialog', { name: 'My account' });

async function openFromChat(page: Page): Promise<Locator> {
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const sidebar = await openSidebar(page);
  // ONE row for the whole deck. The column used to list every section of it inline; the deck carries its
  // own section navigation, so the menu's job is to open it.
  await sidebar.locator('a[href="/account"]').click();
  await expect(page).toHaveURL(/\/account/);
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
    const content = node.querySelector('[data-testid="account-deck-layout"] > section')!.getBoundingClientRect();
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
  // The secondary column sits beside the content, not over it — and it is the SAME column Settings has:
  // 15rem, which is 240px at the app's 16px root, within the tolerance a border and a reserved scrollbar
  // gutter take. A one-sided bound is what let this column sit at 18rem while Settings sat at 15.
  expect(Math.abs(geometry.nav.width - 240)).toBeLessThanOrEqual(8);
  expect(geometry.content.x).toBeGreaterThan(geometry.nav.x + geometry.nav.width - 2);

  // Dispatched on the row's own control, exactly as the settings spec does it: every record carries a
  // help anchor whose expanded hit area covers the row, so a positional click can land on the help
  // instead — and `exact` keeps the row apart from that anchor's own "Help: Security" name.
  await dialog.getByRole('button', { name: 'Security', exact: true })
    .evaluate((row) => (row as HTMLElement).click());
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

/** THE SAME PRESENTATION ON EVERY ARRIVAL. Interception answers a client navigation and nothing else, so
 *  a refresh, a cold load and a shared link used to fall through to a standalone page — the same address
 *  wearing a different product. The slot answers those arrivals too now. */
test('Account refreshes as the same overlay', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await openFromChat(page);
  await page.reload();
  await expect(accountOverlay(page)).toBeVisible();
  await expect(page).toHaveURL(/\/account/);
});

test('a cold load of a deep link opens the overlay, with no standalone page behind it', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account?cat=security');

  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  // Nothing draws the deck a second time underneath: the canonical page owns the address alone.
  await expect(page.locator('[data-module="account"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="account-deck-layout"]')).toHaveCount(1);
});

/** A SECTION ROW MOVES THE DECK THE READER IS IN. A navigation to the pathname the document is already on
 *  is announced in the document instead of routed (lib/sameDocumentNavigation.ts), so the overlay that is
 *  up changes section rather than a second one being raised over it. */
test('a section row inside a cold-loaded overlay changes the section in place', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account?cat=profile');
  await expect(accountOverlay(page)).toBeVisible();

  const sidebar = await openSidebar(page);
  await page.locator('[data-testid="account-navigation-sidebar"]')
    .getByRole('button', { name: 'Security', exact: true })
    .evaluate((row) => (row as HTMLElement).click());

  await expect(page).toHaveURL('/account?cat=security');
  await expect(accountOverlay(page)).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
  // And the deck row stays marked, because the reader has not left the deck.
  await expect(sidebar.locator('a[href="/account"]')).toHaveAttribute('aria-current', 'page');
});

/** Closing is leaving the address, and a cold-loaded overlay has no entry of the app's behind it: back
 *  would do nothing at all, or hand the reader whatever the tab held before the app. */
test('closing a cold-loaded overlay lands on a real page instead of stepping out of the app', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account?cat=profile');
  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(page).toHaveURL('/dash');
  await expect(accountOverlay(page)).toHaveCount(0);
  await expect(page.locator('[data-module="dashboard"]')).toBeVisible();
});

/** The account column is searchable now, exactly as the settings one is, and from the same static index
 *  the command palette reads — so a record found here lands on its section AND its row. */
test('the account search reaches a record by name, from the keyboard', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/account?cat=profile');
  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();

  const search = dialog.getByRole('searchbox', { name: 'Search account' });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill('Interface scale');

  const column = dialog.locator('[data-testid="account-navigation-sidebar"]');
  // The column is filtered to the sections that hold a match, and the matching record is offered on its
  // own beneath its section.
  await expect(column.getByRole('button', { name: 'Security' })).toHaveCount(0);
  // Tab leaves the field for the filtered column rather than for something outside the navigation.
  await page.keyboard.press('Tab');
  await expect(column.locator(':focus')).toHaveCount(1);

  await column.getByRole('button', { name: 'Interface scale', exact: true }).press('Enter');
  // The record itself is what the reader lands on, marked the way the palette marks it — and the anchor
  // is CONSUMED once it has been, so the address the reader keeps names the section alone.
  await expect(dialog.locator('[data-row-id="account.uiScale"]')).toBeVisible();
  await expect(page).toHaveURL('/account?cat=profile');
});

test('Account opens from the identity in the top bar and gives focus back on close', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();

  const identity = page.locator('.top-bar__identity');
  await identity.click();
  // The address first: the overlay is what the route resolves to, so a dialog that has not appeared yet
  // is a slow route rather than a navigation that never happened.
  await expect(page).toHaveURL(/\/account/);
  const dialog = accountOverlay(page);
  await expect(dialog).toBeVisible();
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

/** A DECK OVERLAY ISOLATES THE SHELL BEHIND IT, and does so identically however the reader arrived. The
 *  menu was inert behind Settings opened from the app and live behind a hard-loaded one, which is the same
 *  split this change removes: the deck carries its own navigation, and the way out is the close. */
test('the shell behind a deck overlay is inert, and the close gives it back', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/chat');
  await expect(page.locator('[data-module="chat"]')).toBeVisible();
  const sidebar = await openSidebar(page);
  await sidebar.locator('a[href="/settings"]').click();

  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();
  // The whole shell behind it is marked inert while the deck is up, so the menu cannot be reached past
  // the surface that stands in for the page.
  expect(await sidebar.evaluate((node) => node.closest('[inert]') !== null || node.hasAttribute('inert'))).toBe(true);

  await settings.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(page).toHaveURL('/chat');
  expect(await sidebar.evaluate((node) => node.closest('[inert]') !== null || node.hasAttribute('inert'))).toBe(false);
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
  await expect(page).toHaveURL(/\/account/);
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
/** Its own phone context rather than a resized desktop one: a coarse pointer changes the strip's own
 *  metrics, and a context that began life at 1440 carries layout the reveal was never measured against. */
test.describe('the phone tab strip', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a section at the end of the phone tab strip is scrolled into view on arrival', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // A deep link, which is the plainest arrival there is: the address names one section and the browser
  // opens the overlay on it. The strip is the deck's whole navigation at this width — the shell's column
  // holds a single row for Account — so this is also the only navigation the reader has here.
  await page.goto('/account?cat=terminal');
  await expect(accountOverlay(page)).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Terminal' })).toBeVisible();

  // Polled and scoped INSIDE the overlay: the page hydrates and the deck settles before the strip can
  // reveal anything, and a route transition can leave the outgoing document's own track in the DOM beside
  // it — measuring that one reads a strip laid out for the width the reader came from.
  await expect.poll(async () => page.locator('[data-testid="account-overlay"] [data-testid="account-navigation-tabs"]').evaluate((track) => {
    const item = track.querySelector<HTMLElement>('[aria-current="page"]');
    if (!item) return null;
    const trackBox = track.getBoundingClientRect();
    const itemBox = item.getBoundingClientRect();
    return {
      label: (item.textContent ?? '').trim(),
      within: itemBox.left >= trackBox.left - 1 && itemBox.right <= trackBox.right + 1,
      // The strip moved, not the pane behind it: the reveal is horizontal and nothing else.
      pageStill: (document.scrollingElement?.scrollTop ?? 0) === 0,
    };
  })).toEqual({ label: 'Terminal', within: true, pageStill: true });
  });
});
