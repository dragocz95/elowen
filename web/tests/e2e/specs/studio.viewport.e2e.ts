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
//  - the register's open control measured 43px, one pixel under it, back when Studio tightened the row
//    to 44px and the control is `inset: 0` inside the row's 1px rule. The rhythm is 48px now, so the
//    control clears the floor on its own — the assertion stays because it is the floor that matters,
//    not the rhythm that happens to satisfy it;
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

/** Studio's two desktop columns, from `skins/studio/shared.css`: 256px expanded and the measured 57px
 *  reference rail holding a 32px row. Restated because the browser test measures pixels. */
const NAV_FULL = 256;
const NAV_RAIL = 57;

/** Put a context into a Studio skin.
 *
 *  BOTH halves are required and neither is optional. The cookie is what the account asked for; the
 *  instance allow-list is what it is allowed to have, and `resolveSkin()` (web/lib/skins.ts) drops a
 *  choice that is not on the list back to the operator default. The fake daemon's stock config declares
 *  no `allowedSkins` at all, so without the seed every assertion below would run against Ember and pass
 *  for the wrong reason. */
async function useSkin(page: Page, seed: Seed, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
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
  await expect(page.locator('h1:visible').first()).toBeVisible();
}

test('Studio renders under its own stylesheet, not the operator default', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The guard for every other case in this file: if the allow-list seed ever stops working, the rest of
  // the spec would quietly measure Ember and stay green. This one fails loudly instead.
  await useSkin(app, seed, 'studio-light');
  await openStudio(app, REGISTER);
  await expect(app.locator('[data-testid="studio-navigation"]')).toBeVisible();
  // The canvas is the skin's, not the built-in black — proof the token block is actually applied.
  const canvas = await app.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim());
  expect(canvas.replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3').toLowerCase()).toBe('#ffffff');
});

test('Studio centres working pages in the reference 1152px frame', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1920, height: 900 });
  await openStudio(app, '/account');

  const geometry = await app.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main')!.getBoundingClientRect();
    const shell = document.querySelector<HTMLElement>('.workspace-shell')!.getBoundingClientRect();
    return { width: shell.width, left: shell.left - main.left, right: main.right - shell.right };
  });
  expect(Math.round(geometry.width)).toBe(1_152);
  expect(Math.abs(geometry.left - geometry.right)).toBeLessThanOrEqual(16);
});

test('Studio matches the reference typography, toolbar and settings density', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, REGISTER);

  const pageStyle = await app.evaluate(() => {
    const heading = document.querySelector<HTMLElement>('.workspace-hero h1')!;
    const style = getComputedStyle(heading);
    return { size: style.fontSize, weight: style.fontWeight, spacing: style.letterSpacing, family: style.fontFamily };
  });
  expect(pageStyle.size).toBe('24px');
  expect(pageStyle.weight).toBe('400');
  expect(pageStyle.spacing).toBe('-0.15px');
  expect(pageStyle.family).toContain('Geist');

  const toolbar = app.locator('.page-toolbar__slot .control-surface-toolbar');
  await expect(toolbar).toBeVisible();
  const controlHeights = await toolbar
    .locator('input, button, [role="combobox"], select')
    .evaluateAll((controls) => controls.filter((control) => (control as HTMLElement).offsetParent !== null)
      .map((control) => Math.round(control.getBoundingClientRect().height)));
  expect(controlHeights.length).toBeGreaterThan(2);
  expect([...new Set(controlHeights)]).toEqual([40]);

  await openStudio(app, '/settings?cat=brain');
  const split = app.locator('.settings-group__body[data-columns="2"]').first();
  await expect(split).toBeVisible();
  const settingsGeometry = await split.evaluate((body) => {
    const columns = [...body.querySelectorAll<HTMLElement>(':scope > .settings-group__column')];
    const secondStyle = columns[1] ? getComputedStyle(columns[1]) : null;
    return {
      tracks: getComputedStyle(body).gridTemplateColumns.split(' ').filter(Boolean).length,
      leftBorder: secondStyle?.borderLeftWidth,
      topBorder: secondStyle?.borderTopWidth,
    };
  });
  expect(settingsGeometry.tracks).toBe(1);
  expect(settingsGeometry.leftBorder).toBe('0px');
  expect(settingsGeometry.topBorder).toBe('1px');
});

test('Studio OLED keeps the chat full-width, left-aligned and in its own top bar', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await seed.messages([
    { id: 'u1', role: 'user', text: 'Please check the deployment status.' },
    { id: 'a1', role: 'assistant', text: 'The deployment is healthy.', segments: [{ kind: 'text', text: 'The deployment is healthy.' }] },
  ]);
  await useSkin(app, seed, 'studio-oled');
  await app.setViewportSize({ width: 1920, height: 900 });
  await openStudio(app, '/chat');
  await expect(app.locator('[data-variant="full"] [data-testid="chat-transcript"]')).toBeVisible();
  await expect(app.locator('[data-role="you"] .chat-user-message')).toBeVisible();
  await expect(app.locator('[data-role="assistant"] .chat-markdown')).toBeVisible();
  await expect(app.locator('[data-testid="page-top-bar-host"] .chat-page-toolbar')).toBeVisible();
  await expect(app.locator('.top-bar__context-nav')).toHaveCount(0);

  const geometry = await app.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-variant="full"]')!.getBoundingClientRect();
    const transcriptElement = document.querySelector<HTMLElement>('[data-variant="full"] [data-testid="chat-transcript"]')!;
    const transcript = transcriptElement.getBoundingClientRect();
    const composerElement = document.querySelector<HTMLElement>('[data-variant="full"] .chat-composer')!;
    const composer = composerElement.getBoundingClientRect();
    const user = document.querySelector<HTMLElement>('[data-role="you"] .chat-user-message')!;
    const userBox = user.getBoundingClientRect();
    const assistantTurn = document.querySelector<HTMLElement>('[data-role="assistant"]')!.getBoundingClientRect();
    const assistant = document.querySelector<HTMLElement>('[data-role="assistant"] .chat-markdown')!;
    const assistantBox = assistant.getBoundingClientRect();
    const userStyle = getComputedStyle(user);
    const assistantStyle = getComputedStyle(assistant);
    const composerStyle = getComputedStyle(composerElement);
    return {
      surfaceWidth: surface.width,
      transcriptWidth: transcript.width,
      threadWidth: assistantTurn.width,
      composerWidth: composer.width,
      left: transcript.left - surface.left,
      right: surface.right - transcript.right,
      composerLeft: composer.left - surface.left,
      composerRight: surface.right - composer.right,
      userLeft: userBox.left - transcript.left,
      assistantLeft: assistantBox.left - transcript.left,
      userBackground: userStyle.backgroundColor,
      userRadius: userStyle.borderRadius,
      userMaxWidth: userStyle.maxInlineSize,
      assistantFontSize: assistantStyle.fontSize,
      assistantLineHeight: assistantStyle.lineHeight,
      assistantFontFamily: assistantStyle.fontFamily,
      composerBackground: composerStyle.backgroundColor,
      composerRadius: composerStyle.borderRadius,
    };
  });
  expect(geometry.surfaceWidth).toBeGreaterThan(1_100);
  expect(geometry.transcriptWidth).toBeCloseTo(geometry.surfaceWidth, 0);
  expect(geometry.threadWidth).toBeGreaterThan(geometry.surfaceWidth - 50);
  expect(geometry.composerWidth).toBeGreaterThan(geometry.surfaceWidth - 50);
  expect(Math.abs(geometry.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.right)).toBeLessThanOrEqual(1);
  expect(geometry.composerLeft).toBeCloseTo(geometry.composerRight, 0);
  expect(geometry.userLeft).toBeCloseTo(geometry.assistantLeft, 0);
  expect(geometry.userBackground).toBe('rgb(28, 32, 34)');
  expect(geometry.userRadius).toBe('22px');
  expect(geometry.userMaxWidth).toBe('70%');
  expect(geometry.assistantFontSize).toBe('16px');
  expect(geometry.assistantLineHeight).toBe('26px');
  expect(geometry.assistantFontFamily).toContain('BlinkMacSystemFont');
  expect(geometry.composerBackground).toBe('rgb(8, 13, 15)');
  expect(geometry.composerRadius).toBe('28px');

  await app.setViewportSize({ width: 900, height: 800 });
  await expect(app.locator('.chat-page-toolbar__wide-controls')).toBeHidden();
  await expect(app.locator('.chat-page-toolbar__overflow')).toBeVisible();
  const narrowBar = await app.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.chat-page-toolbar')!.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>('.top-bar__actions')!.getBoundingClientRect();
    return { toolbarRight: toolbar.right, actionsLeft: actions.left };
  });
  expect(narrowBar.toolbarRight).toBeLessThanOrEqual(narrowBar.actionsLeft + 1);

  await app.setViewportSize({ width: 390, height: 844 });
  // A phone keeps the ruled bar, and the conversation's own controls ride IN it beside the hamburger.
  // The regression this pins: the bar wasted on a hamburger while the toolbar sat in a second, local row
  // below it — out of the sticky bar and under the hero.
  await expect(app.locator('.top-bar__menu')).toBeVisible();
  await expect(app.locator('[data-testid="page-top-bar-host"] .chat-page-toolbar')).toBeVisible();
  await expect(app.locator('.chat-page-toolbar')).toHaveCount(1);
  await expect(app.locator('.chat-page-toolbar__wide-controls')).toHaveCount(0);
  const phoneBar = await app.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.top-bar--bar')!.getBoundingClientRect();
    const menu = document.querySelector<HTMLElement>('.top-bar__menu')!.getBoundingClientRect();
    const toolbar = document.querySelector<HTMLElement>('.chat-page-toolbar')!.getBoundingClientRect();
    return { barTop: bar.top, barBottom: bar.bottom, menuRight: menu.right, toolbarTop: toolbar.top, toolbarBottom: toolbar.bottom, toolbarLeft: toolbar.left };
  });
  expect(phoneBar.toolbarTop).toBeGreaterThanOrEqual(phoneBar.barTop - 1);
  expect(phoneBar.toolbarBottom).toBeLessThanOrEqual(phoneBar.barBottom + 1);
  expect(phoneBar.toolbarLeft).toBeGreaterThanOrEqual(phoneBar.menuRight - 1);
  // The pickers a phone folds behind ⋯ still open from the bar.
  await app.getByRole('button', { name: 'More options' }).click();
  await expect(app.locator('[data-chat-popover] [data-testid="chat-model-picker"]')).toBeVisible();
});

test('returning from Home opens the full chat at its newest turn', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await seed.messages(Array.from({ length: 35 }, (_, index) => [
    { id: `u-${index}`, role: 'user' as const, text: `Question ${index}` },
    { id: `a-${index}`, role: 'assistant' as const, text: `Answer ${index}`, segments: [{ kind: 'text' as const, text: `Answer ${index}` }] },
  ]).flat());
  await useSkin(app, seed, 'studio-oled');
  await app.setViewportSize({ width: 1440, height: 800 });
  await openStudio(app, '/chat');
  await expect(app.getByText('Answer 34')).toBeVisible();

  await app.locator('main').evaluate((main) => { main.scrollTop = 0; });
  await app.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(app).toHaveURL(/\/dash$/);
  await app.getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(app).toHaveURL(/\/chat$/);
  await expect(app.getByText('Answer 34')).toBeVisible();

  const bottomGap = await app.locator('main').evaluate((main) => main.scrollHeight - main.scrollTop - main.clientHeight);
  expect(bottomGap).toBeLessThanOrEqual(2);
});

test('sectioned Studio pages keep plain tabs in the page at every width', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-oled');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, '/account');

  // In the PAGE, under the metric rail — the sections belong to the page and change with it, and the top
  // bar is the one strip that does not. The chat surface still portals its own controls up there.
  const submenu = app.locator('.workspace-shell > .workspace-shell__section-navigation [role="radiogroup"]');
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(submenu).toHaveAttribute('data-nowrap', 'true');
  await expect(submenu).toHaveAttribute('data-variant', 'line');
  const desktopStyle = await submenu.evaluate((element) => {
    const active = element.querySelector<HTMLElement>('[aria-checked="true"]')!;
    return {
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
      activeBorder: getComputedStyle(active).borderBottomStyle,
    };
  });
  expect(desktopStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(desktopStyle.radius).toBe('0px');
  expect(desktopStyle.activeBorder).toBe('solid');
  await expect(app.locator('.workspace-shell__section-sidebar, .workspace-shell__section-mobile')).toHaveCount(0);

  await app.setViewportSize({ width: 390, height: 844 });
  await openStudio(app, '/account');
  await expect(submenu).toBeVisible();
  await expect(submenu).toHaveAttribute('aria-orientation', 'horizontal');
  await expect(app.locator('.workspace-shell__section-navigation [role="combobox"]')).toHaveCount(0);
});

test('Studio pages share metrics, filters, title and actions in one calm order', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-oled');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, REGISTER);
  // The canonical order: what the page IS, then its live figures, then the controls that narrow it. A
  // promoted register toolbar lands in the toolbar row's slot, BELOW the title — it used to be lifted
  // above it, so every register opened on its filters and named itself second.
  const memoryToolbar = app.locator('.page-toolbar__slot .control-surface-toolbar');
  await expect(memoryToolbar).toBeVisible();
  const desktopOrder = await app.evaluate(() => {
    const head = document.querySelector<HTMLElement>('.workspace-hero__head')!.getBoundingClientRect();
    const metrics = document.querySelector<HTMLElement>('.workspace-hero__metrics')!.getBoundingClientRect();
    const toolbar = document.querySelector<HTMLElement>('.page-toolbar')!.getBoundingClientRect();
    const actions = document.querySelector<HTMLElement>('.workspace-hero__actions')!.getBoundingClientRect();
    return { headTop: head.top, metricsTop: metrics.top, toolbarTop: toolbar.top, actionsRight: actions.right, headRight: head.right };
  });
  expect(desktopOrder.headTop).toBeLessThan(desktopOrder.metricsTop);
  expect(desktopOrder.metricsTop).toBeLessThan(desktopOrder.toolbarTop);
  expect(desktopOrder.actionsRight).toBeLessThanOrEqual(desktopOrder.headRight + 1);

  await app.setViewportSize({ width: 390, height: 844 });
  await openStudio(app, '/settings?cat=models');
  await expect(app.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
  await expect(app.locator('.page-toolbar__slot .settings-toolbar input[type="search"]')).toBeVisible();
  await expect(app.locator('.workspace-hero__metrics')).toHaveCount(0);
  await expect(app.locator('.workspace-hero__actions button')).toHaveCount(0);
  const mobileOrder = await app.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.page-toolbar')!.getBoundingClientRect();
    const head = document.querySelector<HTMLElement>('.workspace-hero__head')!.getBoundingClientRect();
    return { toolbarTop: toolbar.top, headTop: head.top };
  });
  expect(mobileOrder.headTop).toBeLessThan(mobileOrder.toolbarTop);
  const modelColumns = await app.locator('.settings-model-row--elowen:visible').evaluateAll((rows) => rows.map((row) => {
    const identity = row.querySelector<HTMLElement>('.settings-model-row__identity')!.getBoundingClientRect();
    const controls = row.querySelector<HTMLElement>('.settings-model-row__controls')!.getBoundingClientRect();
    return { identityRight: identity.right, controlsLeft: controls.left, rowRight: row.getBoundingClientRect().right, controlsRight: controls.right };
  }));
  expect(modelColumns.length).toBeGreaterThan(0);
  for (const column of modelColumns) {
    expect(column.identityRight).toBeLessThanOrEqual(column.controlsLeft + 1);
    expect(column.controlsRight).toBeLessThanOrEqual(column.rowRight + 1);
  }

  await app.getByRole('radio', { name: 'System' }).click();
  await expect(app.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  await expect(app.locator('.page-toolbar__slot .settings-toolbar')).toHaveCount(0);
  await expect(app.locator('.workspace-hero__metrics')).toBeVisible();
  await expect(app.locator('.workspace-hero__actions button')).toHaveCount(2);
  const mobileActions = await app.evaluate(() => {
    const actions = document.querySelector<HTMLElement>('.workspace-hero__actions')!.getBoundingClientRect();
    const head = document.querySelector<HTMLElement>('.workspace-hero__head')!.getBoundingClientRect();
    return { actionsRight: actions.right, headRight: head.right, actionsTop: actions.top, headTop: head.top };
  });
  expect(mobileActions.actionsRight).toBeLessThanOrEqual(mobileActions.headRight + 1);
  expect(mobileActions.actionsTop).toBeGreaterThanOrEqual(mobileActions.headTop);

  await expect(app.locator('.settings-row__description')).toHaveCount(0);
  // THE TWO-LINE BAND. A phone gives a settings card ~358px, and the value column it used to hold there
  // was ~120px — enough for a switch and for nothing else, which is what crushed every picker and meter
  // on this page. A record folds instead: its name and help on the first line, its control, status and
  // actions together on the second. Two lines, never three, and nothing past the card's edge.
  const rowBands = await app.locator('.settings-row:visible:has(.settings-row__trailing)').evaluateAll((rows) => rows.map((row) => {
    const label = row.querySelector<HTMLElement>('.settings-row__label')!.getBoundingClientRect();
    const trailing = row.querySelector<HTMLElement>('.settings-row__trailing')!.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    return {
      name: row.querySelector<HTMLElement>('.settings-row__title')?.textContent?.trim() ?? '',
      labelLeft: label.left, labelBottom: label.bottom,
      trailingTop: trailing.top, trailingLeft: trailing.left, trailingRight: trailing.right,
      rowLeft: rect.left, rowRight: rect.right,
    };
  }));
  expect(rowBands.length).toBeGreaterThan(0);
  for (const band of rowBands) {
    expect(band.trailingTop, `${band.name} still puts its value beside its name`).toBeGreaterThanOrEqual(band.labelBottom - 1);
    // Both lines start at the same edge; the trailing one is not indented into a leftover column.
    expect(Math.abs(band.trailingLeft - band.labelLeft)).toBeLessThanOrEqual(1);
    expect(band.labelLeft).toBeGreaterThanOrEqual(band.rowLeft - 1);
    expect(band.trailingRight, `${band.name} draws past its own row`).toBeLessThanOrEqual(band.rowRight + 1);
  }

  const pushRow = app.locator('.settings-row').filter({ hasText: 'Push notification contact' });
  await pushRow.getByRole('button', { name: 'Help' }).click();
  await expect(app.getByRole('tooltip')).toContainText('The address used to sign push notifications');
});

test('nothing on a Studio page is laid out wider than the 320px it has', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 320, height: 700 });
  for (const route of ['/dash', '/chat', REGISTER, '/projects', '/users', '/account', '/settings']) {
    // `openStudio`, not `goto`: every other case in this file goes through it because a cold route under
    // `next dev` can be served as the operator default, and this one measuring Ember would pass for the
    // wrong reason — silently, since Ember has no horizontal overflow at 320px either.
    await openStudio(app, route);
    // And wait for the shell to have MEASURED this width. The navigation mode comes from a resize
    // observer over the content region, so between hydration and the first measurement the column is
    // still 256px wide and <main> is a 54px sliver — every box in the page overhangs it, and a
    // per-element assertion would report that transient state as an overflow on every route.
    await expect(app.locator('[data-testid="studio-navigation"]')).toHaveAttribute('data-mode', 'drawer');
    // `documentElement.scrollWidth` on its own proves almost nothing here: base.css sets
    // `body { overflow: hidden }`, so the document never grows a horizontal scrollbar whatever happens
    // inside it. Overflow in this app shows up as CLIPPING instead, so the measurement is per element:
    // the right edge of every laid-out box against the client width of the first ancestor that would
    // CLIP it. A scrollable ancestor (`auto`/`scroll`) is deliberately not a failure — content wider
    // than a horizontal scroller is still reachable — but content past a `hidden`/`clip` edge, or past
    // the viewport, is simply gone.
    const spills = await app.evaluate(() => {
      /** The ancestor that would CUT this element off, or null when the nearest ancestor governing the
       *  inline axis scrolls instead — content wider than a scroller is reachable, not lost. With no
       *  such ancestor the bound is the viewport, which body's `overflow: hidden` makes a clip too. */
      const clipper = (el: Element): Element | null => {
        // A fixed element is positioned against the viewport, so no ancestor's overflow governs it.
        if (getComputedStyle(el).position === 'fixed') return document.documentElement;
        for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
          const overflowX = getComputedStyle(node).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') return null;
          if (overflowX === 'hidden' || overflowX === 'clip') return node;
        }
        return document.documentElement;
      };
      const describe = (el: Element) =>
        `${el.tagName.toLowerCase()}.${el.className.toString().trim().split(/\s+/)[0] ?? ''}`;
      const offenders: string[] = [];
      for (const el of document.body.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const container = clipper(el);
        if (!container) continue;
        // `clientWidth` is the PADDING box, while the rect's left edge is the BORDER box, so the
        // container's own left border has to be added back or every bordered card reads one pixel short.
        const edge = container.getBoundingClientRect().left
          + parseFloat(getComputedStyle(container).borderLeftWidth)
          + container.clientWidth;
        // Half a pixel of slack: sub-pixel layout rounds a flush edge either way.
        if (box.right <= edge + 0.5) continue;
        offenders.push(`${describe(el)} right=${Math.round(box.right)} clipped at ${Math.round(edge)} by ${describe(container)}`);
        if (offenders.length === 5) break;
      }
      return offenders;
    });
    expect(spills, `${route} lays out content past its container at 320px in Studio`).toEqual([]);
  }
});

test('the Studio page bar stays put while the register scrolls under it', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The bar is `position: sticky`, and a sticky box is clamped to its CONTAINING BLOCK. A wrapper around
  // it whose only child is the header is exactly the header's height, which leaves a sticky range of
  // zero: the bar looks perfect until the first wheel click and then simply leaves. Studio's register
  // header offsets itself by the bar's own height precisely BECAUSE the bar stays, so the same wrapper
  // also parks every column name below a gap with rows scrolling visibly above it.
  //
  // Neither half is visible in a screenshot of an unscrolled page, and no unit test can see it: it is a
  // property of the ancestor CHAIN, which only a laid-out document has. Hence this case, and hence the
  // assertion being about position AFTER scrolling rather than about any class.
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, REGISTER);
  const bar = app.locator('.top-bar--bar');
  await expect(bar).toBeVisible();

  // THE RANGE, first and unconditionally. A sticky box travels within its containing block — for a
  // `sticky` element that is its nearest block-container ancestor — so the range is that ancestor's
  // height less the bar's own. Asserting it directly needs no scroll, no rows and no content of any
  // kind, which is what makes it the assertion that cannot pass for an accidental reason. A wrapper
  // reintroduced around the header collapses this to 0 whatever else the page is doing.
  const geometry = await app.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.top-bar--bar')!;
    const parent = el.parentElement!;
    const style = getComputedStyle(parent);
    return {
      position: getComputedStyle(el).position,
      bar: el.getBoundingClientRect().height,
      // The containing block is the parent's CONTENT box, so its padding comes off.
      containingBlock: parent.getBoundingClientRect().height
        - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    };
  });
  expect(geometry.position, 'the bar variant is sticky').toBe('sticky');
  expect(Math.round(geometry.bar), 'the Studio reference bar height').toBe(50);
  expect(
    geometry.containingBlock - geometry.bar,
    'the bar has room to stay behind — a wrapper holding only the header leaves none',
  ).toBeGreaterThan(geometry.bar * 4);

  // And then the behaviour itself, once the register is actually long enough to scroll.
  await expect(app.locator('.data-table-grid').first()).toBeVisible();
  const scrolled = await app.evaluate(() => {
    const main = document.querySelector('main')!;
    if (main.scrollHeight <= main.clientHeight + 200) return null;
    main.scrollBy(0, 400);
    return main.scrollTop;
  });
  expect(scrolled, 'the register is long enough to scroll').toBeGreaterThan(200);
  expect(Math.round((await bar.boundingBox())!.y), 'the bar after scrolling').toBe(0);
  // The column names sit directly under the 50px bar, with neither a gap nor an overlap.
  expect(Math.round((await app.locator('.data-table-header').first().boundingBox())!.y),
    'the sticky column names clear the bar exactly').toBe(Math.round(geometry.bar));
});

test('Studio opens the reference chat rail only on demand and remembers the choice', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await useSkin(app, seed, 'studio-light');
  await seed.messages([{
    id: 'ask-agent-font',
    role: 'assistant',
    text: 'The assistant rail keeps its compact reading density.',
    segments: [{ kind: 'text', text: 'The assistant rail keeps its compact reading density.' }],
  }]);
  const nav = app.locator('[data-testid="studio-navigation"]');

  await app.setViewportSize({ width: 1440, height: 900 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'full');
  expect(Math.round((await nav.boundingBox())!.width), 'the default reference column').toBe(NAV_FULL);
  await expect(app.locator('.advisor-panel')).toHaveCount(0);

  await app.getByRole('button', { name: 'Open assistant' }).click();
  await expect(app.locator('.advisor-panel')).toBeVisible();
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  expect(Math.round((await app.locator('.advisor-panel').boundingBox())!.width), 'the reference chat rail').toBe(336);
  await openStudio(app, REGISTER);
  await expect(app.locator('.advisor-panel')).toBeVisible();
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  await expect(app.getByText('The assistant rail keeps its compact reading density.')).toBeVisible();

  const shellRhythm = await app.evaluate(() => {
    const item = document.querySelector<HTMLElement>('.studio-nav__body .studio-nav__item')!;
    const itemIcon = item.querySelector<SVGElement>('svg')!;
    const footerItem = document.querySelector<HTMLElement>('.studio-nav__footer > div:not(.studio-nav__user) .studio-nav__item')!;
    const navElement = document.querySelector<HTMLElement>('.studio-nav')!;
    const brandLockup = document.querySelector<HTMLElement>('.studio-nav__brand-lockup')!;
    const brandMark = document.querySelector<HTMLElement>('.studio-nav__brand-mark')!;
    const brandName = document.querySelector<HTMLElement>('.studio-nav__brand-name')!;
    const search = document.querySelector<HTMLElement>('.top-bar__search')!;
    const searchIcon = search.querySelector<SVGElement>('svg')!;
    const skinButton = document.querySelector<HTMLElement>('.skin-switcher__button')!;
    const skinLabel = skinButton.querySelector<HTMLElement>('.skin-switcher__name')!;
    const row = document.querySelector<HTMLElement>('.shell-workspace-row')!;
    const workspace = document.querySelector<HTMLElement>('.shell-workspace')!;
    const slot = document.querySelector<HTMLElement>('.studio-advisor-slot')!;
    const advisor = document.querySelector<HTMLElement>('.advisor-panel')!;
    const advisorHeader = document.querySelector<HTMLElement>('.advisor-panel__header')!;
    const advisorControl = advisorHeader.querySelector<HTMLButtonElement>('button')!;
    const advisorControlIcon = advisorControl.querySelector<SVGElement>('svg')!;
    const advisorText = advisor.querySelector<HTMLElement>('.chat-markdown')!;
    const navToggle = document.querySelector<HTMLElement>('.top-bar__nav-toggle')!;
    const searchStyle = getComputedStyle(search);
    const rowStyle = getComputedStyle(row);
    const workspaceStyle = getComputedStyle(workspace);
    const navStyle = getComputedStyle(navElement);
    const advisorStyle = getComputedStyle(advisor);
    const workspaceBox = workspace.getBoundingClientRect();
    const advisorBox = advisor.getBoundingClientRect();
    return {
      itemHeight: Math.round(item.getBoundingClientRect().height),
      itemIcon: { width: itemIcon.getAttribute('width'), stroke: itemIcon.getAttribute('stroke-width') },
      footerItemHeight: Math.round(footerItem.getBoundingClientRect().height),
      navWidth: Math.round(navElement.getBoundingClientRect().width),
      navTransition: { duration: navStyle.transitionDuration, easing: navStyle.transitionTimingFunction },
      brandClipped: brandLockup.getBoundingClientRect().right > navElement.getBoundingClientRect().right,
      brandMarkWidth: Math.round(brandMark.getBoundingClientRect().width),
      brandName: {
        display: getComputedStyle(brandName).display,
        size: getComputedStyle(brandName).fontSize,
        family: getComputedStyle(brandName).fontFamily,
      },
      search: {
        width: Math.round(search.getBoundingClientRect().width),
        height: Math.round(search.getBoundingClientRect().height),
        border: searchStyle.borderTopWidth,
        inActions: search.closest('.top-bar__actions') !== null,
        icon: { width: searchIcon.getAttribute('width'), stroke: searchIcon.getAttribute('stroke-width') },
      },
      skinHeight: Math.round(skinButton.getBoundingClientRect().height),
      skinBorder: getComputedStyle(skinButton).borderTopWidth,
      skinFont: getComputedStyle(skinLabel).fontSize,
      bodyFont: getComputedStyle(document.body).fontFamily,
      workspace: {
        x: Math.round(workspaceBox.x),
        y: Math.round(workspaceBox.y),
        radius: workspaceStyle.borderRadius,
        shadow: workspaceStyle.boxShadow,
        transition: rowStyle.transitionDuration,
        easing: rowStyle.transitionTimingFunction,
      },
      advisor: {
        width: Math.round(advisorBox.width),
        y: Math.round(advisorBox.y),
        slotWidth: Math.round(slot.getBoundingClientRect().width),
        gap: Math.round(advisorBox.left - workspaceBox.right),
        opacity: advisorStyle.opacity,
        translate: advisorStyle.translate,
        scale: advisorStyle.scale,
        transition: advisorStyle.transitionDuration,
        easing: advisorStyle.transitionTimingFunction,
      },
      advisorHeaderHeight: Math.round(advisorHeader.getBoundingClientRect().height),
      advisorControl: {
        size: Math.round(advisorControl.getBoundingClientRect().width),
        iconWidth: advisorControlIcon.getAttribute('width'),
        iconStroke: advisorControlIcon.getAttribute('stroke-width'),
        duration: getComputedStyle(advisorControl).transitionDuration,
      },
      advisorText: {
        size: getComputedStyle(advisorText).fontSize,
        lineHeight: getComputedStyle(advisorText).lineHeight,
        family: getComputedStyle(advisorText).fontFamily,
      },
      topBarControlDuration: getComputedStyle(navToggle).transitionDuration,
    };
  });
  expect({
    itemHeight: shellRhythm.itemHeight,
    itemIcon: shellRhythm.itemIcon,
    footerItemHeight: shellRhythm.footerItemHeight,
    navWidth: shellRhythm.navWidth,
    navTransition: shellRhythm.navTransition,
    brandClipped: shellRhythm.brandClipped,
    brandMarkWidth: shellRhythm.brandMarkWidth,
    brandName: shellRhythm.brandName,
    search: shellRhythm.search,
    skinHeight: shellRhythm.skinHeight,
    skinBorder: shellRhythm.skinBorder,
    skinFont: shellRhythm.skinFont,
    workspace: shellRhythm.workspace,
    advisor: shellRhythm.advisor,
    advisorHeaderHeight: shellRhythm.advisorHeaderHeight,
    advisorControl: shellRhythm.advisorControl,
    advisorText: shellRhythm.advisorText,
    topBarControlDuration: shellRhythm.topBarControlDuration,
  }).toEqual({
    itemHeight: 32,
    itemIcon: { width: '18', stroke: '1.5' },
    footerItemHeight: 32,
    navWidth: NAV_RAIL,
    navTransition: { duration: '0.15s', easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    // Folded, the column is the mark and nothing else: the wordmark is out of the flow rather than sliced
    // by the rail's edge, so the lockup fits inside the column it belongs to.
    brandClipped: false,
    brandMarkWidth: 30,
    brandName: { display: 'none', size: '18px', family: shellRhythm.brandName.family },
    // Command search is one 32px glyph in the action cluster, not a field holding the middle of the bar.
    search: { width: 32, height: 32, border: '0px', inActions: true, icon: { width: '18', stroke: '1.5' } },
    skinHeight: 32,
    skinBorder: '1px',
    skinFont: '13px',
    workspace: {
      x: 16,
      y: 16,
      radius: '20px',
      shadow: shellRhythm.workspace.shadow,
      transition: '0.2s, 0.2s, 0.2s',
      easing: 'cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1), cubic-bezier(0.4, 0, 0.2, 1)',
    },
    advisor: {
      width: 336,
      y: 0,
      slotWidth: 344,
      gap: 15,
      opacity: '1',
      translate: '0px',
      scale: '1',
      transition: '0.3s, 0.3s, 0.3s',
      easing: 'cubic-bezier(0, 0, 0.2, 1), cubic-bezier(0, 0, 0.2, 1), cubic-bezier(0, 0, 0.2, 1)',
    },
    advisorHeaderHeight: 50,
    advisorControl: { size: 32, iconWidth: '18', iconStroke: '1.5', duration: '0.075s, 0.075s' },
    advisorText: { size: '14px', lineHeight: '21px', family: shellRhythm.advisorText.family },
    topBarControlDuration: '0.075s',
  });
  expect(shellRhythm.workspace.shadow).not.toBe('none');
  expect(shellRhythm.bodyFont).toContain('Inter Variable');
  expect(shellRhythm.advisorText.family).toContain('BlinkMacSystemFont');
  // The wordmark is the one thing set in the display face, so the menu's own name cannot silently become
  // one more line of interface text.
  expect(shellRhythm.brandName.family).toContain('Space Grotesk Variable');

  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'full');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(NAV_FULL);
  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(NAV_RAIL);

  await app.locator('.advisor-panel').getByRole('button', { name: 'Dock position' }).click();
  await app.getByRole('button', { name: 'Dock left' }).click();
  await expect(nav).toHaveAttribute('data-side', 'right');
  await expect(app.getByTestId('studio-nav-collapse')).toHaveAttribute('data-nav-side', 'right');
  await app.locator('.advisor-panel').getByRole('button', { name: 'Dock position' }).click();
  await app.getByRole('button', { name: 'Dock right' }).click();
  await expect(nav).toHaveAttribute('data-side', 'left');
  await expect(app.getByTestId('studio-nav-collapse')).toHaveAttribute('data-nav-side', 'left');

  await app.locator('.advisor-panel').getByRole('button', { name: 'Close' }).click();
  await expect(app.locator('.advisor-panel')).toHaveAttribute('aria-hidden', 'true');
  await expect.poll(() => app.locator('.advisor-panel').evaluate((panel) => getComputedStyle(panel).opacity)).toBe('0');
  await openStudio(app, REGISTER);
  await expect(app.locator('.advisor-panel')).toHaveCount(0);

  // Folding is still available on a roomy desktop and is persisted under Studio's own key, without
  // changing the spatial design's sidebar preference.
  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'rail');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the folded column').toBe(NAV_RAIL);
  await app.getByTestId('studio-nav-collapse').click();
  await expect(nav).toHaveAttribute('data-mode', 'full');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the expanded column').toBe(NAV_FULL);

  await app.setViewportSize({ width: 1024, height: 900 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'full');
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width), 'the column at 1024px').toBe(NAV_FULL);
  await expect(app.locator('.advisor-panel')).toHaveCount(0);

  await app.setViewportSize({ width: 1023, height: 900 });
  await openStudio(app, REGISTER);
  await expect(nav).toHaveAttribute('data-mode', 'drawer');
  const closed = await nav.boundingBox();
  expect(closed!.x, 'a closed sheet is off-screen').toBeLessThan(0);
  expect(Math.round(closed!.width), 'the mobile sheet spans the viewport').toBe(1023);
});

test('the Studio chat is centred on its own frame and its bar pickers open out of it', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await seed.messages([
    { id: 'u1', role: 'user', text: 'Where does the conversation sit?' },
    { id: 'a1', role: 'assistant', text: 'Centred.', segments: [{ kind: 'text', text: 'Centred.' }] },
  ]);
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1920, height: 900 });
  await openStudio(app, '/chat');
  await expect(app.locator('[data-testid="page-top-bar-host"] .chat-page-toolbar')).toBeVisible();

  const frame = await app.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main')!;
    // The CONTENT box: <main> keeps a stable scrollbar gutter, and measuring against its border box would
    // read that reserved strip as the frame being 10px off centre.
    const scroller = { left: main.getBoundingClientRect().left, right: main.getBoundingClientRect().left + main.clientWidth };
    const surface = document.querySelector<HTMLElement>('[data-variant="full"]')!;
    // The capped, centred frame the shell puts /chat in — the surface's own scroll parent chain up to the
    // element carrying --chat-max.
    const cap = surface.closest<HTMLElement>('.mx-auto')!.getBoundingClientRect();
    const slot = document.querySelector<HTMLElement>('.top-bar__page-slot')!.getBoundingClientRect();
    return {
      capWidth: Math.round(cap.width),
      leftGap: Math.round(cap.left - scroller.left),
      rightGap: Math.round(scroller.right - cap.right),
      capCentre: Math.round(cap.left + cap.width / 2),
      slotCentre: Math.round(slot.left + slot.width / 2),
      pageMeasure: getComputedStyle(document.documentElement).getPropertyValue('--content-max').trim(),
      chatMeasure: getComputedStyle(document.documentElement).getPropertyValue('--chat-max').trim(),
    };
  });
  // 96rem, wider than the 72rem a page of records is read at, and centred rather than pinned to the edge.
  expect(frame.chatMeasure).toBe('96rem');
  expect(frame.pageMeasure).toBe('72rem');
  expect(frame.capWidth, 'the conversation is capped at its own measure').toBe(1536);
  expect(frame.leftGap, 'the frame is centred in the workspace').toBe(frame.rightGap);
  // The page's own controls sit above the page they belong to, not against the window's left edge.
  expect(Math.abs(frame.slotCentre - frame.capCentre)).toBeLessThanOrEqual(1);

  // The regression: the bar's leading column clipped its own overflow, so a picker's listbox — anchored
  // under a 50px bar — was rendered, focusable and entirely invisible. `toBeVisible` cannot see that (the
  // element has a box either way), so this hit-tests the menu where the pointer would land.
  await app.locator('[data-testid="page-top-bar-host"] [data-testid="chat-model-picker"] button').click();
  const menu = await app.evaluate(() => {
    const listbox = document.querySelector<HTMLElement>('.top-bar__page-slot [role="listbox"]');
    if (!listbox) return null;
    const box = listbox.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 8);
    return { width: Math.round(box.width), height: Math.round(box.height), reachable: listbox.contains(hit) };
  });
  expect(menu, 'the model listbox opened').not.toBeNull();
  expect(menu!.width).toBeGreaterThan(0);
  expect(menu!.height).toBeGreaterThan(0);
  expect(menu!.reachable, 'the listbox is clipped away by the bar').toBe(true);

  // A route that portals NOTHING must still keep its universal actions at the right edge. The centre
  // region is `empty:hidden` there, and a `display: none` box is not a grid item — so without an explicit
  // column the cluster fell into the middle track and the avatar sat in the middle of the bar.
  await openStudio(app, REGISTER);
  await expect(app.locator('.top-bar__page-slot')).toBeHidden();
  const actions = await app.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.top-bar--bar')!;
    const cluster = document.querySelector<HTMLElement>('.top-bar__actions')!.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return { gap: Math.round(barBox.right - cluster.right), padding: getComputedStyle(bar).paddingRight };
  });
  expect(actions.padding).toBe('12px');
  expect(actions.gap, 'the action cluster sits at the trailing edge').toBe(12);
});

test('no page mounts a hero mascot, and every one still states its mascot prop', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // The decorative column is gone from the shared hero: it carried no information, both shipped designs
  // hid it outright, and it cost every register most of a screen before the first record. What did NOT
  // go is the prop — no page is forked, every route still states its mascot state, and it now reaches
  // the document as `data-mascot` so a design can answer the page's state without any artwork.
  await useSkin(app, seed, 'studio-light');
  await app.setViewportSize({ width: 1440, height: 900 });
  for (const route of [REGISTER, '/projects', '/settings']) {
    await openStudio(app, route);
    await expect(app.locator('.workspace-hero__mascot'), `${route} still mounts the hero mascot column`).toHaveCount(0);
    await expect(app.locator('.workspace-hero .spatial-mascot'), `${route} still paints mascot artwork`).toHaveCount(0);
    await expect(app.locator('.workspace-hero[data-mascot]'), `${route} lost the mascot state input`).toHaveCount(1);
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
    expect(Math.round((await drawer.boundingBox())!.width), 'the sheet spans the phone').toBe(390);

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

test('Studio chat composer buttons keep the touch floor on a short coarse-pointer screen', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  const { context, page } = await studioTouchPage(browser, seed, 'studio-oled', { width: 740, height: 360 });
  try {
    await openStudio(page, '/chat');
    const toolbar = page.locator('.chat-page-toolbar');
    await expect(toolbar).toBeVisible();
    expect(await toolbar.evaluate((element) => element.closest('.top-bar__page-slot') === null)).toBe(true);
    const controls = page.locator('.chat-composer > button');
    await expect(controls.first()).toBeVisible();
    const sizes = await controls.evaluateAll((buttons) => buttons.map((button) => {
      const box = button.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }));
    expect(sizes.length, 'the composer exposes attach and send/stop controls').toBeGreaterThanOrEqual(2);
    for (const size of sizes) {
      expect(size.width, 'a composer button is wide enough to tap').toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(size.height, 'a composer button is tall enough to tap').toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
  } finally {
    await context.close();
  }
});

test('Studio settings help buttons stay tappable on a coarse-pointer phone', async ({ browser, seed }, testInfo) => {
  authedOnly(testInfo);
  const { context, page } = await studioTouchPage(browser, seed, 'studio-oled', { width: 390, height: 844 });
  try {
    await openStudio(page, '/settings');
    const help = page.getByRole('button', { name: 'Help' }).first();
    await expect(help).toBeVisible();
    const box = await help.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
    expect(box?.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
    await help.click();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(help).toHaveAttribute('aria-describedby', await tooltip.getAttribute('id') ?? '');
  } finally {
    await context.close();
  }
});

/** Settings → Elowen AI, seeded so BOTH multi-value cards have something to lay out: one connected OAuth
 *  account (which is what carries a usage rail) and one API-key provider entry with a long endpoint, a
 *  key and two models — the row that shows the most badges at once. */
async function seedBrainSettings(seed: Seed): Promise<void> {
  await seed.response('config', {
    ...Seed.defaults.config,
    allowedSkins: ['default', 'studio-light', 'studio-oled'],
    brain: {
      ...Seed.defaults.config.brain,
      providers: [{
        id: 'coresynth',
        label: 'CoreSynth Proxy',
        type: 'openai',
        baseUrl: 'https://ai.coresynth.example.com/v1',
        models: ['gpt-5-codex', 'gpt-5-mini'],
        apiKeySet: true,
      }],
    },
  });
}

// A phone rendering of Settings → Elowen AI, reported from an iPhone: in "Connected accounts (OAuth)" the
// account name, the "Connected" badge, the usage window labels and their percentages were all drawn on
// top of one another and the meters were not visible at all; in "Providers" the entry's own name and
// endpoint were gone and only the type/key badges remained.
//
// Both cards hold a MULTI-VALUE record — an account carries a badge, one meter per rate-limit window and
// two buttons; a provider entry carries an endpoint, a model count, up to three badges and three buttons.
// Studio keeps its two-column value table down to the narrowest phone, and that rule is more specific
// than the base stylesheet's phone collapse, so those records were held in a ~120px value column with
// `flex-wrap: nowrap`: the meters resolved to ZERO width and the badge group overran the label. Measured
// at the time: the meter fills were 0px wide and the provider's action group was laid out 321px wide
// starting 50px LEFT of the card at 320px.
//
// So the assertions are the two halves of that: a stacked record's parts each get a line of their own
// inside the card (nothing negative, nothing past the edge, no box overlapping the title), and a meter is
// actually a meter. The inline records in the same page are measured alongside — they fold to the same
// single track now, because the two-column table a phone was holding is what left every record's value
// in ~120px, and the canonical record answers that with a two-line band instead of a narrower column.
for (const size of [{ width: 390, height: 844 }, { width: 320, height: 700 }]) {
  test(`Studio keeps account and provider records readable at ${size.width}px`, async ({ browser, seed }, testInfo) => {
    authedOnly(testInfo);
    const { context, page } = await studioTouchPage(browser, seed, 'studio-light', size);
    try {
      // After `studioTouchPage`, whose own `useSkin` writes the allow-list over `config` — this seed
      // carries the allow-list forward AND adds the provider entry, so it must be the last writer.
      await seedBrainSettings(seed);
      await openStudio(page, '/settings?cat=brain');
      // The connected account and the provider entry, by their own names — the two the screenshot lost.
      await expect(page.getByText('Claude account')).toBeVisible();
      await expect(page.getByText('CoreSynth Proxy')).toBeVisible();

      const layout = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('.settings-row')]
          .filter((row) => row.getBoundingClientRect().width > 0);
        const box = (el: Element) => el.getBoundingClientRect();
        /** Do two boxes share any area? Two parts of one record may sit on one line or on two, but they
         *  may never be drawn over each other — which is the defect, in one predicate. */
        const overlaps = (a: DOMRect, b: DOMRect) =>
          a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

        return rows.map((row) => {
          const rect = box(row);
          const title = row.querySelector<HTMLElement>('.settings-row__title');
          const parts = [...row.querySelectorAll<HTMLElement>('.settings-row__status, .settings-row__control, .settings-row__actions')];
          return {
            label: title?.textContent?.trim() ?? '',
            trailing: row.dataset.trailing ?? '',
            columns: getComputedStyle(row).gridTemplateColumns,
            titleWidth: title ? Math.round(box(title).width) : 0,
            // How far any part of the record falls outside the row's own box, in either direction.
            spill: Math.round(Math.max(0, ...parts.map((p) => Math.max(rect.left - box(p).left, box(p).right - rect.right)))),
            // Any trailing part drawn over the record's own name.
            collidesWithTitle: title ? parts.some((p) => overlaps(box(title), box(p))) : false,
            meters: [...row.querySelectorAll<HTMLElement>('[data-testid="oauth-usage-track"]')]
              .map((track) => ({ track: Math.round(box(track).width), fill: Math.round(box(track.firstElementChild!).width) })),
          };
        });
      });

      const stacked = layout.filter((row) => row.trailing === 'stack');
      const inline = layout.filter((row) => row.trailing === 'inline');
      // Guard: if the accounts card ever stops rendering, every assertion below would hold vacuously.
      expect(stacked.map((row) => row.label)).toEqual(
        expect.arrayContaining(['Claude account', 'CoreSynth Proxy']),
      );

      // The symptom first, because it is the one a person sees: the connected account's usage rail. A
      // meter has to be wide enough to read a proportion off, and the fill has to be a proportion OF it.
      const account = stacked.find((row) => row.label === 'Claude account')!;
      expect(account.meters).toHaveLength(2);
      for (const meter of account.meters) {
        expect(meter.track, 'a usage meter collapsed to nothing').toBeGreaterThan(60);
        expect(meter.fill).toBeGreaterThan(0);
        expect(meter.fill).toBeLessThanOrEqual(meter.track);
      }
      // 42% and 87% of the same track: the rail must still read as pressure, not as two full bars.
      expect(account.meters[0]!.fill).toBeLessThan(account.meters[1]!.fill);

      for (const row of stacked) {
        expect(row.titleWidth, `${row.label} has no room for its own name`).toBeGreaterThan(40);
        expect(row.spill, `${row.label} draws part of itself outside its row`).toBe(0);
        expect(row.collidesWithTitle, `${row.label} draws a value over its own name`).toBe(false);
      }

      // And the structure underneath it: at this width EVERY record gets the card's full width and lays
      // itself out as a two-line band. A stacked record then gives each of its several values a line;
      // an inline one keeps its control, status and actions together on the single line below its name.
      expect(inline.length).toBeGreaterThan(0);
      for (const row of [...stacked, ...inline]) {
        expect(row.columns.split(' '), `${row.label} is still in the narrow value column`).toHaveLength(1);
      }
      for (const row of inline) {
        expect(row.spill, `${row.label} draws part of itself outside its row`).toBe(0);
        expect(row.collidesWithTitle, `${row.label} draws a value over its own name`).toBe(false);
      }
    } finally {
      await context.close();
    }
  });
}

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
  // The row's open control is `position: absolute; inset: 0` inside the row, so it inherits the row's
  // CONTENT box. At the 44px rhythm Studio used to set, that box measured 43px — one pixel under the
  // floor, on every register in the app. At 48px it measures 47px, which is why the pointer-gated bump
  // that used to buy back the pixel is gone.
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
  // style outranks the `var(--color-background)` rule that follows the skin. Switching left the canvas — and the
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
    token: getComputedStyle(document.documentElement).getPropertyValue('--color-background').trim(),
  }));
  expect(after.canvas, 'the canvas actually changed').not.toBe(before);
  // No stale inline paint may survive the switch — that is the whole mechanism of the defect.
  expect(after.inline, 'the anti-FOUC fill is handed back to the stylesheet').toBe('');
  expect(after.bodyInline, 'the body fill is handed back too').toBe('');
  // And what is painted is the new design's own token rather than a second copy of it. The comparison is
  // on the resolved colour, not the spelling — the expansion covers a minified 3-digit form if one returns.
  expect(after.canvas).toBe('rgb(3, 8, 10)');
  expect(after.token.replace(/^#([\da-f])([\da-f])([\da-f])$/i, '#$1$1$2$2$3$3').toLowerCase()).toBe('#03080a');
});
