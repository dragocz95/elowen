// Layout guarantees for the STUDIO skin family, in a real browser.
//
// `viewport.e2e.ts` measures the same class of property on the built-in design. None of it reached
// Studio: a skin is chosen by a `data-skin` attribute the server resolves from a cookie AGAINST the
// instance allow-list, so a spec that only sets the cookie still renders the operator's default and
// silently measures Ember four times over. `studioPage()` below does both halves, which is what makes
// these the first assertions that run against Studio's own stylesheets at all.
//
// Every case here stands for a defect that was found by driving the compiled skin in Chrome:
//  - every row of the navigation column measured 32px on a coarse pointer, and at drawer width that
//    column IS the phone's only menu, so the whole menu was under the touch floor at once;
//  - the register's open control measured 43px, one pixel under it, because Studio tightens the row to
//    44px and the control is `inset: 0` inside the row's 1px rule;
//  - the hero mascot had to disappear from the working pages WITHOUT the shared component being forked,
//    which is a rule only a rendered document can confirm.
// The overflow and sidebar-geometry cases carry no known defect: they are the two properties the whole
// design rests on, and both are cheap to hold and expensive to notice breaking.
import { test, expect, type Page, type Browser } from '../fixtures/index.ts';
import { STORAGE_STATE } from '../../../playwright.config.ts';
import { Seed } from '../fixtures/Seed.ts';
import { adminUser } from '../seed/fixtures.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

/** The register page, as in `viewport.e2e.ts`: the surface carrying a table, a sticky header and a
 *  toolbar all at once. */
const REGISTER = '/memory';

/** The touch floor the app declares in `--touch-target` (web/app/styles/tokens.css). Restated as a
 *  number because a test asserts against a measured box, not against the token. */
const TOUCH_TARGET = 44;

/** Studio's two columns, from `skins/studio/shared.css`: `width: 16rem` expanded, `3.25rem` folded. */
const NAV_FULL = 256;
const NAV_RAIL = 52;

/** Put a context into a Studio skin.
 *
 *  BOTH halves are required and neither is optional. The cookie is what the account asked for; the
 *  instance allow-list is what it is allowed to have, and `resolveSkin()` (web/lib/skins.ts) drops a
 *  choice that is not on the list back to the operator default. The fake daemon's stock config declares
 *  no `allowedSkins` at all, so without the seed every assertion below would run against Ember and pass
 *  for the wrong reason. */
async function useSkin(page: Page, seed: Seed, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'midnight', 'studio-light', 'studio-oled'] });
  const url = new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url());
  await page.context().addCookies([{ name: 'elowen-skin', value: skin, domain: url.hostname, path: '/', sameSite: 'Lax' }]);
}

/** A page reporting a COARSE pointer, already wearing a Studio skin.
 *
 *  See the note in `viewport.e2e.ts`: `viewport` + `hasTouch` leave the pointer media feature at `fine`,
 *  so every `@media (pointer: coarse)` rule stays off and a test written to prove a 44px touch target
 *  measures the compact mouse control instead. Only `isMobile` flips it. The caller closes the context.
 */
async function studioTouchPage(browser: Browser, seed: Seed, skin: 'studio-light' | 'studio-oled', size: { width: number; height: number }) {
  const context = await browser.newContext({ storageState: STORAGE_STATE, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await useSkin(page, seed, skin);
  return { context, page };
}

/** Open a route and wait for Studio's own chrome, not merely for the document. The navigation paints only
 *  once the stored arrangement is known (`[data-ready]` in shared.css), and measuring before that reads a
 *  column that is still transparent. */
async function openStudio(page: Page, route: string): Promise<void> {
  // The skin is resolved SERVER-side, from the cookie against `/config`. The harness runs `next dev`, so
  // the first hit on a route compiles it, and a layout whose config fetch loses that race resolves the
  // allow-list to null and serves the operator default — deliberately, because not knowing the list must
  // never hand somebody else's design out (web/lib/serverPrefetch.ts). That makes the FIRST document on a
  // cold route unreliable here in a way it is not under `next start`, where this was never observed.
  //
  // So the navigation is retried rather than the assertion loosened: the document still has to arrive
  // wearing Studio, it is just allowed more than one attempt to be compiled first.
  await expect(async () => {
    await page.goto(route);
    expect(await page.locator('html').getAttribute('data-skin')).toMatch(/^studio-/);
  }).toPass({ timeout: 20_000 });
  await expect(page.locator('h1')).toBeVisible();
}

test('Studio renders under its own stylesheet, not the operator default', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The guard for every other case in this file: if the allow-list seed ever stops working, the rest of
  // the spec would quietly measure Ember and stay green. This one fails loudly instead.
  await useSkin(app, seed, 'studio-light');
  await openStudio(app, REGISTER);
  await expect(app.locator('[data-testid="studio-navigation"]')).toBeVisible();
  // The canvas is the skin's, not the built-in black — proof the token block is actually applied.
  const canvas = await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim());
  expect(canvas.toLowerCase()).toBe('#fafafa');
});

test('no Studio page scrolls sideways at 320px', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 320, height: 700 });
  for (const route of ['/dash', '/chat', REGISTER, '/projects', '/users', '/account', '/settings']) {
    await app.goto(route);
    await expect(app.locator('h1')).toBeVisible();
    const overflow = await app.evaluate(() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
    });
    // A horizontal document scrollbar at the narrowest supported width means something was laid out to a
    // width nobody has. A skin restyles the shell itself, so this cannot be inherited from the core spec.
    expect(overflow.scrollWidth, `${route} overflows horizontally at 320px in Studio`).toBeLessThanOrEqual(overflow.clientWidth);
  }
});

test('the Studio column is 256px, folds to 52px, and becomes a sheet on a phone', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  const nav = app.locator('[data-testid="studio-navigation"]');

  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'full');
  expect(Math.round((await nav.boundingBox())!.width), 'the expanded column').toBe(NAV_FULL);

  // The fold is a control, not a width: it must survive at a width that still offers the choice.
  // Polled, not sampled: the column travels between the two widths over `--motion-base`, and the
  // attribute flips at the START of that transition — reading the box straight after it caught the
  // column mid-slide at 63px.
  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the folded column').toBe(NAV_RAIL);
  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'full');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the unfolded column').toBe(NAV_FULL);

  // 768 is the last width with a column; 767 is the first with a sheet. The boundary is the defect the
  // core spec was written around, so Studio states it too rather than assuming it survived the reskin.
  await app.setViewportSize({ width: 768, height: 1024 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the column at 768px').toBe(NAV_RAIL);

  await app.setViewportSize({ width: 767, height: 1024 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'drawer');
  // A closed sheet is parked off-screen, which is what makes the content full-width beneath it.
  expect((await nav.boundingBox())!.x, 'a closed sheet is off-screen').toBeLessThan(0);
});

test('Studio drops the hero mascot from a working page and keeps the page', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The mascot belongs to the ember identity and must not appear over a register — but no page may be
  // FORKED to achieve that: every route states its mascot as a prop and Studio restyles rather than
  // rewrites. So the element stays in the document and simply stops painting, and the hero's two-column
  // grid must collapse rather than leave an empty track behind it.
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1440, height: 900 });
  for (const route of [REGISTER, '/projects', '/settings']) {
    await openStudio(app, route);
    const mascot = await app.evaluate(() => {
      const el = document.querySelector('.workspace-hero__mascot');
      if (!el) return null;
      return { display: getComputedStyle(el).display, width: el.getBoundingClientRect().width };
    });
    expect(mascot, `${route} still renders the hero mascot element`).not.toBeNull();
    expect(mascot!.display, `${route} paints the hero mascot under Studio`).toBe('none');
    expect(mascot!.width, `${route} leaves the mascot an empty track`).toBe(0);
  }
});

test('every Studio navigation row is a real touch target on a coarse pointer', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  // The defect: `.studio-nav__item` is drawn at a 32px rhythm — right for a mouse, 12px under the floor
  // for a finger — and at this width the sheet is the ONLY menu the phone has, so every destination in
  // the app was under the target at once. The stylesheet tree is unlayered, so a `pointer-coarse:` utility
  // on the element could never have fixed it; the skin has to state the floor itself.
  const { context, page } = await studioTouchPage(browser, seed, 'studio-light', { width: 390, height: 844 });
  try {
    await openStudio(page, REGISTER);
    await page.getByRole('button', { name: /toggle menu/i }).click();
    const drawer = page.locator('.overlay-nav-drawer');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect.poll(async () => (await drawer.boundingBox())!.x, 'the sheet slides in').toBeGreaterThanOrEqual(0);

    const rows = await page.evaluate(() => [...document.querySelectorAll('.studio-nav__item')]
      .map((el) => ({ label: (el.textContent || '').trim(), h: Math.round(el.getBoundingClientRect().height) })));
    expect(rows.length, 'the sheet lists destinations').toBeGreaterThan(3);
    const short = rows.filter((row) => row.h < TOUCH_TARGET);
    expect(short, `navigation rows under ${TOUCH_TARGET}px: ${JSON.stringify(short)}`).toEqual([]);

    // The disclosure header is a control too, and it sits between the rows it opens.
    const toggles = await page.evaluate(() => [...document.querySelectorAll('.studio-nav__group-toggle')]
      .map((el) => Math.round(el.getBoundingClientRect().height)));
    for (const h of toggles) expect(h, 'a group header is a touch target').toBeGreaterThanOrEqual(TOUCH_TARGET);
  } finally {
    await context.close();
  }
});

test('a destination in the Studio nav sheet can actually be tapped', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  // The defect this stands for made the phone's entire menu inert. `.studio-nav` declared `z-index: 1`
  // for every mode, and because the stylesheet tree is UNLAYERED that skin selector out-specified the
  // `.overlay-layer-nav-drawer` class the component carries — the class that assigns `--z-nav-drawer`
  // (80). The sheet therefore rendered BELOW its own scrim: the menu looked washed out, and a tap on a
  // destination landed on the scrim, so it dismissed the menu instead of navigating. Every measurement
  // still passed — the rows were the right size, in the right place, with the right contrast — because
  // the only thing wrong was which layer they were on.
  //
  // So this asserts the one property those measurements cannot: that pressing a destination GOES there.
  // No `force`: the click has to succeed through real hit-testing, the way a finger does.
  const { context, page } = await studioTouchPage(browser, seed, 'studio-light', { width: 390, height: 844 });
  try {
    await openStudio(page, REGISTER);
    await page.getByRole('button', { name: /toggle menu/i }).click();
    await expect.poll(async () => (await page.locator('.overlay-nav-drawer').boundingBox())!.x).toBeGreaterThanOrEqual(0);

    // The sheet is above the scrim, so the row is what a tap at its centre reaches.
    const hit = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.studio-nav__item')].find((el) => el.getAttribute('href') === '/projects');
      if (!row) return { found: false, reached: false };
      const box = row.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { found: true, reached: at === row || row.contains(at) };
    });
    expect(hit.found, 'the sheet lists Projects').toBe(true);
    expect(hit.reached, 'a tap at the centre of a destination reaches the destination').toBe(true);

    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(page).toHaveURL(/\/projects$/);
  } finally {
    await context.close();
  }
});

test('a Studio register row can be opened with a finger', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  // Studio tightens the register to a 44px rhythm. The row's open control is `position: absolute;
  // inset: 0` inside it, so it inherits the row's CONTENT box — 44px less the 1px rule left a 43px
  // target, one pixel under the floor, on every register in the app.
  // The account directory belongs to the onboarding lane and is empty outside it, so the register has to
  // be given rows or it lays out its empty state and there is no control to measure.
  await seed.response('users', Array.from({ length: 6 }, (_, i) => ({
    ...adminUser, id: i + 1, username: `user-${i}`, name: `User ${i}`, is_admin: i % 2 === 0,
  })));
  const { context, page } = await studioTouchPage(browser, seed, 'studio-light', { width: 390, height: 844 });
  try {
    await openStudio(page, '/users');
    await expect(page.locator('.data-table-row-open').first()).toBeVisible();
    const heights = await page.evaluate(() => [...document.querySelectorAll('.data-table-row-open')]
      .map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(heights.length, 'the register has openable rows').toBeGreaterThan(0);
    for (const h of heights) expect(h, 'a row open control is a touch target').toBeGreaterThanOrEqual(TOUCH_TARGET);
  } finally {
    await context.close();
  }
});

test('switching skin repaints the canvas and the browser chrome with it', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The defect: the server writes an anti-FOUC `background-color` inline onto <html>/<body>, and an inline
  // style outranks the `var(--color-bg)` rule that follows the skin. Switching left the canvas — and the
  // theme colour the address bar reports — frozen at whatever design the DOCUMENT was served as, while
  // every surface above it repainted. Switching must hand the canvas back to the cascade.
  await useSkin(app, seed, 'studio-light');
  await openStudio(app, REGISTER);
  const before = await app.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);

  await app.getByRole('button', { name: /^Skin:/i }).first().click();
  await expect(app.locator('html')).toHaveAttribute('data-skin', 'studio-oled');

  const after = await app.evaluate(() => ({
    canvas: getComputedStyle(document.documentElement).backgroundColor,
    inline: document.documentElement.style.backgroundColor,
    bodyInline: document.body.style.backgroundColor,
    token: getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim(),
  }));
  expect(after.canvas, 'the canvas actually changed').not.toBe(before);
  // No stale inline paint may survive the switch — that is the whole mechanism of the defect.
  expect(after.inline, 'the anti-FOUC fill is handed back to the stylesheet').toBe('');
  expect(after.bodyInline, 'the body fill is handed back too').toBe('');
  // And what is painted is the new design's own token rather than a second copy of it. The token is read
  // back as authored-then-minified (`#000`), so the comparison is on the resolved colour, not the spelling.
  expect(after.canvas).toBe('rgb(0, 0, 0)');
  expect(after.token.replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3').toLowerCase()).toBe('#000000');
});
