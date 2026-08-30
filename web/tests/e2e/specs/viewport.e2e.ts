// Layout guarantees that only a real browser with real layout can hold. Every case here stands for a
// defect that shipped: the app used to render itself at ~70% through an automatic `zoom` on <html> for
// every window between 768px and about 1440px, and the register grew from a design that was only ever
// looked at inside that shrink. Once the zoom was removed, the desktop layout had to work at its real
// size — and the three things that broke first were reachability at 320px, the register header, and the
// 767/768 boundary itself.
//
// These are measurements, not screenshots: a pixel baseline goes stale on any deliberate change and
// tells nobody what it was protecting. Each expectation below names a property that must hold at every
// width, so a future layout is free to look different and still has to stay usable.
import { test, expect, type Browser, type Page } from '@playwright/test';
import { STORAGE_STATE } from '../../../playwright.config';

/** Every case needs the authenticated shell; the unauthed project only ever sees the login form. */
const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

/** The register page: it is the only surface that carries a paginated table, a sticky header AND a
 *  control-surface toolbar, which is most of what the redesign changed. */
const REGISTER = '/memory';

/** Let the register's data land and its layout settle before measuring anything. */
async function openRegister(page: Page): Promise<void> {
  await page.goto(REGISTER);
  await expect(page.locator('[role="table"] .data-table-header')).toBeVisible();
  await expect(page.locator('[role="row"]').nth(3)).toBeVisible();
}

/**
 * A page that reports a COARSE pointer, the way a phone does.
 *
 * Resizing the default context is not enough: `viewport` and `hasTouch` leave the pointer media features
 * at `fine`, so every `pointer-coarse:` utility and every `@media (pointer: coarse)` block stays off and
 * a test measures the 36px mouse control it was written to prove is a 44px touch target. Only `isMobile`
 * turns on Chrome's mobile device emulation, which is what actually flips `pointer`/`hover`. Touch-target
 * sizing is gated on the pointer and never on the width — a narrow window on a laptop still has a mouse
 * and must not grow finger-sized controls — so the emulation has to be a real one.
 *
 * The caller closes the returned context.
 */
async function touchPage(browser: Browser, storageState: string, size: { width: number; height: number }) {
  const context = await browser.newContext({ storageState, viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  return { context, page: await context.newPage() };
}

test('the app never rescales itself: html zoom is the user preference at every width', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // 767 and 768 are the two sides of the cliff this replaces: one pixel used to flip the app from a
  // phone layout at full size to a desktop layout at 70%, taking body text from 12.5 to 8.7 physical
  // pixels. Everything between 768 and ~1440 was shrunk; the widths below straddle the whole old range.
  const widths = [320, 390, 740, 767, 768, 1024, 1280, 1440, 1900];
  const measured: { width: number; zoom: string; fontSize: string; layoutWidth: number }[] = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/dash');
    await expect(page.locator('h1')).toBeVisible();
    measured.push(await page.evaluate(() => ({
      width: window.innerWidth,
      zoom: getComputedStyle(document.documentElement).zoom,
      fontSize: getComputedStyle(document.body).fontSize,
      layoutWidth: document.documentElement.clientWidth,
    })));
  }
  for (const m of measured) {
    // `1` is the default preference. A skin or an accessibility setting may raise it, but nothing in
    // the LAYOUT may set it: a width-driven zoom is exactly the defect.
    expect(m.zoom, `zoom at ${m.width}px`).toBe('1');
    // The layout viewport must BE the window. Under a zoom it was the window divided by the factor.
    expect(m.layoutWidth, `layout viewport at ${m.width}px`).toBe(m.width);
  }
  // Type size is continuous across the old cliff — not merely unzoomed on each side of it.
  const at767 = measured.find((m) => m.width === 767)!;
  const at768 = measured.find((m) => m.width === 768)!;
  expect(at768.fontSize, 'body type must not jump across the 767/768 boundary').toBe(at767.fontSize);
});

test('no page scrolls sideways at 320px', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 320, height: 700 });
  for (const route of ['/dash', '/chat', REGISTER, '/projects', '/users', '/account', '/settings']) {
    await page.goto(route);
    await expect(page.locator('h1')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const de = document.documentElement;
      return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
    });
    // A horizontal document scrollbar at the narrowest supported width means something was laid out to
    // a width nobody has. Deliberately scrollable strips (a metric row, the section rail) live inside
    // their own `overflow-x: auto` port and never reach the document.
    expect(overflow.scrollWidth, `${route} overflows horizontally at 320px`).toBeLessThanOrEqual(overflow.clientWidth);
  }
});

test('metric rails have one outer hairline and no item separators on core pages', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const route of ['/settings', '/account', '/users']) {
    await page.goto(route);
    await expect(page.locator('.workspace-hero__metrics')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const hero = document.querySelector<HTMLElement>('.workspace-hero')!;
      const rail = document.querySelector<HTMLElement>('.workspace-hero__metrics')!;
      const railStyle = getComputedStyle(rail);
      const metrics = [...rail.querySelectorAll<HTMLElement>('.workspace-metric')].map((metric) => {
        const rect = metric.getBoundingClientRect();
        const style = getComputedStyle(metric);
        return { top: rect.top, borderLeft: style.borderLeftWidth, borderRight: style.borderRightWidth };
      });
      const main = document.querySelector<HTMLElement>('main')!;
      return {
        heroBorderBottom: getComputedStyle(hero).borderBottomWidth,
        railBorderTop: railStyle.borderTopWidth,
        paddingTop: Number.parseFloat(railStyle.paddingTop),
        paddingBottom: Number.parseFloat(railStyle.paddingBottom),
        flexWrap: railStyle.flexWrap,
        metrics,
        pageOverflow: main.scrollWidth - main.clientWidth,
      };
    });
    expect(geometry.heroBorderBottom, route).toBe('1px');
    expect(geometry.railBorderTop, route).toBe('0px');
    expect(geometry.paddingTop, route).toBeGreaterThanOrEqual(16);
    expect(geometry.paddingBottom, route).toBeGreaterThanOrEqual(16);
    expect(geometry.flexWrap, route).toBe('nowrap');
    expect(new Set(geometry.metrics.map((metric) => Math.round(metric.top))).size, route).toBe(1);
    for (const metric of geometry.metrics) {
      expect(metric.borderLeft, route).toBe('0px');
      expect(metric.borderRight, route).toBe('0px');
    }
    expect(geometry.pageOverflow, route).toBeLessThanOrEqual(1);
  }
});

test('the pager can still reach page 2 at 320px', async ({ browser }, testInfo) => {
  authedOnly(testInfo);
  // The original defect: the pager laid its controls out in a non-wrapping row, so "next" ran from
  // x=265 to x=357 inside an `overflow-x-hidden` main. It was painted, it was not disabled, and it
  // could not be clicked — page 2 was unreachable on a phone.
  const { context, page } = await touchPage(browser, STORAGE_STATE, { width: 320, height: 700 });
  try {
    await openRegister(page);

    const next = page.getByRole('button', { name: /next page/i });
    await expect(next).toBeEnabled();
    const box = (await next.boundingBox())!;
    expect(box.x, 'the next control starts inside the viewport').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'the next control ENDS inside the viewport').toBeLessThanOrEqual(320);
    // A finger has to be able to land on it, not just a hit-test.
    expect(box.height, 'next is at least one touch target tall').toBeGreaterThanOrEqual(44);

    const firstPage = await page.locator('[role="row"]:not(.data-table-header)').first().innerText();
    // No `force`: this tap has to succeed the way a user's would, through real hit-testing.
    await next.click();
    await expect(page.locator('[role="row"]:not(.data-table-header)').first()).not.toHaveText(firstPage);
  } finally {
    await context.close();
  }
});

test('the register header stays put and stays opaque while rows scroll under it', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // Two defects in one place. The fill used to be `rgb(255 255 255 / 0.012)`, so rows read straight
  // through the column names; and the `sticky` utility on the header lost silently to the unlayered
  // `position: relative` that every row carries, so the header did not stick at all.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRegister(page);

  const measured = await page.evaluate(() => {
    const table = document.querySelector('[role="table"]')!;
    const header = table.querySelector<HTMLElement>('.data-table-header')!;
    // Whatever actually owns the register's scrolling — the page, or an inner pane.
    let port: HTMLElement | null = null;
    for (let node = table.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(node).overflowY)) { port = node; break; }
    }
    const before = header.getBoundingClientRect().top;
    if (port) port.scrollTop = 900; else window.scrollTo(0, 900);
    const headerBox = header.getBoundingClientRect();
    const rows = [...table.querySelectorAll('[role="row"]')].filter((row) => row !== header);
    const style = getComputedStyle(header);
    return {
      position: style.position,
      background: style.backgroundColor,
      movedUp: before - headerBox.top,
      visible: headerBox.top >= -1 && headerBox.bottom <= window.innerHeight + 1,
      rowsUnderHeader: rows.filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top < headerBox.bottom - 0.5 && box.bottom > headerBox.top + 0.5;
      }).length,
    };
  });

  expect(measured.position).toBe('sticky');
  expect(measured.movedUp, 'the header stayed with the viewport while the rows moved').toBeGreaterThan(4);
  expect(measured.visible, 'the header is still on screen after scrolling').toBe(true);
  // Rows genuinely pass beneath it — which is precisely why the fill may not be see-through.
  expect(measured.rowsUnderHeader, 'rows scroll under the header').toBeGreaterThan(0);
  // Any notation is fine; a transparent or near-transparent fill is not.
  expect(measured.background).not.toMatch(/transparent/);
  const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(measured.background)?.[1];
  if (alpha !== undefined) expect(Number(alpha), `header fill alpha (${measured.background})`).toBeGreaterThan(0.9);
});

test('the rows of a register share one height', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // Rows once measured 27/41/59/59/49px against a 48px rhythm everywhere else, which is what makes a
  // register unscannable. One deliberate exception exists (`height="tall"`), and it is opt-in per row.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRegister(page);
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('[role="table"] [role="row"]:not(.data-table-header)')]
      .map((row) => ({ h: Math.round(row.getBoundingClientRect().height), tall: row.getAttribute('data-row-height') === 'tall' }))
      .filter((row) => !row.tall)
      .map((row) => row.h));
  expect(heights.length).toBeGreaterThan(5);
  expect([...new Set(heights)], 'every standard row is the same height').toHaveLength(1);
});

test('no page toolbar overflows its own box', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // /p/skills clipped the last Segmented option by 15px at 320px, because the toolbar was a fixed-width
  // row in a box narrower than itself. A toolbar either fits or scrolls; it never hides a control.
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const route of [REGISTER, '/projects', '/users']) {
      await page.goto(route);
      // The toolbar has to be measured on a SETTLED surface. Measured while the register is still
      // loading, the surface is briefly a fraction of its final width and every toolbar in it reads as
      // overflowing — a race that fails as loudly as a real defect and means nothing.
      await expect(page.locator('.page-toolbar__row').first()).toBeVisible();
      // Polled, not sampled once: the surface reaches its real width only after the shell's container
      // query resolves, and a toolbar measured before that reads as overflowing a 92px surface. The
      // assertion is about the SETTLED layout, so a genuine overflow still fails — it just never clears.
      await expect.poll(async () => page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.page-toolbar__row')]
          .filter((bar) => bar.scrollWidth > bar.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(bar).overflowX))
          .map((bar) => `${bar.className} ${bar.scrollWidth}>${bar.clientWidth}`)),
      `${route} at ${width}px`).toEqual([]);
    }
  }
});

test('every page names itself with exactly one h1', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // /chat had no h1 at all — a page with no heading has no name in a screen reader's landmark list.
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const route of ['/dash', '/chat', REGISTER, '/projects', '/users', '/account', '/settings']) {
    await page.goto(route);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).not.toBeEmpty();
  }
});

test('the mobile nav drawer is a dialog you can leave', async ({ browser }, testInfo) => {
  authedOnly(testInfo);
  // It used to have no close control, no dialog role and `overflow-y: hidden` — openable, and then only
  // escapable by guessing that the strip of backdrop beside it was a target.
  const { context, page } = await touchPage(browser, STORAGE_STATE, { width: 390, height: 844 });
  try {
    await page.goto(REGISTER);
    await expect(page.locator('h1')).toBeVisible();

    await page.getByRole('button', { name: /toggle menu/i }).click();
    const drawer = page.locator('.overlay-nav-drawer');
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAttribute('aria-modal', 'true');

    const close = drawer.getByRole('button', { name: /close/i });
    const box = (await close.boundingBox())!;
    expect(box.height, 'the close control is a touch target').toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);

    // It is on screen while open — the closed state parks it outside the viewport. Polled, because it
    // gets there through a 200ms slide and a mid-transition x proves nothing either way.
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await drawer.boundingBox())!.x).toBeLessThan(0);
  } finally {
    await context.close();
  }
});

test('a detail overlay takes the screen on a phone and is a side rail on a desktop', async ({ page, browser }, testInfo) => {
  authedOnly(testInfo);
  // Presentation follows the viewport, not the call site: a desktop side rail on a phone leaves a
  // useless strip of backdrop, and heights are dvh so a collapsing mobile toolbar cannot overstate the
  // screen. Escape closes, and focus is trapped while it is open.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(REGISTER);
  await expect(page.locator('[role="row"]').nth(3)).toBeVisible();
  await page.locator('.data-table-row-open').first().click();

  const rail = page.locator('[role="dialog"][data-presentation]');
  await expect(rail).toHaveAttribute('data-presentation', 'drawer');
  await expect(rail).toHaveAttribute('aria-modal', 'true');
  expect(await rail.evaluate((el) => el.contains(document.activeElement)), 'focus moves into the rail').toBe(true);
  for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
  expect(await rail.evaluate((el) => el.contains(document.activeElement)), 'focus stays inside the rail').toBe(true);
  await page.keyboard.press('Escape');
  await expect(rail).toHaveCount(0);

  const phone = await touchPage(browser, STORAGE_STATE, { width: 390, height: 844 });
  try {
    await phone.page.goto(REGISTER);
    await expect(phone.page.locator('[role="row"]').nth(3)).toBeVisible();
    await phone.page.locator('.data-table-row-open').first().click();
    const surface = phone.page.locator('[role="dialog"][data-presentation]');
    // EVERY automatic overlay takes the whole screen on a phone — `resolveOverlayPresentation`
    // (overlayDepth.tsx) returns `fullscreen` for the phone viewport whatever the depth or the intent,
    // and `tests/components/overlayPresentation.test.tsx` pins the same answer for this rail. A partial
    // sheet hides half the surface it just opened, and a drawer leaves a useless strip of backdrop.
    await expect(surface).toHaveAttribute('data-presentation', 'fullscreen');
    // It ends at the bottom of the SCREEN. A `vh` height overshoots here by however much a collapsing
    // mobile toolbar is worth, which is exactly why every overlay height moved to `dvh`. Polled: the
    // surface arrives on an animation, and it is only past the bottom edge until that lands.
    await expect.poll(async () => {
      const box = (await surface.boundingBox())!;
      return Math.round(box.y + box.height);
    }, 'the surface ends at the bottom of the screen').toBeLessThanOrEqual(844);
    const box = (await surface.boundingBox())!;
    expect(Math.round(box.width), 'the surface spans the width').toBe(390);
    expect(Math.round(box.y), 'a fullscreen surface starts at the top edge').toBe(0);
  } finally {
    await phone.context.close();
  }
});

test('the register reaches the first screen on a phone', async ({ page }, testInfo) => {
  authedOnly(testInfo);
  // The hero used to push the first row roughly 1700px down the page: the register was two full screens
  // below the page it titled. A container query collapses the hero so the content starts where it can
  // be seen.
  await page.setViewportSize({ width: 390, height: 844 });
  await openRegister(page);
  const firstRowTop = await page.evaluate(() => {
    const row = document.querySelector('[role="row"]:not(.data-table-header)')!;
    return row.getBoundingClientRect().top + window.scrollY;
  });
  expect(firstRowTop, 'the first row starts within the first screen').toBeLessThan(844);
});

// An automatic overlay on a phone takes the whole screen (`resolveOverlayPresentation`, overlayDepth.tsx),
// and taking the screen is only useful if the content inside it can be REACHED. `ModalBody` is a flex
// column, so its children kept the default `flex-shrink: 1` and a body taller than the dialog compressed
// them to fit instead of overflowing: `scrollHeight` equalled `clientHeight`, so there was nothing to
// scroll, and the task list's own `overflow-hidden` silently clipped the rows that no longer fitted —
// 1785px of a 2429px list, with the filter input squashed from 36px to 23px on the way.
test('the phone task overlay scrolls to its last task under a pinned header', async ({ browser }, testInfo) => {
  authedOnly(testInfo);
  const { context, page } = await touchPage(browser, STORAGE_STATE, { width: 390, height: 844 });
  try {
    await page.goto('/chat');
    await expect(page.locator('[data-variant="full"]')).toBeVisible();

    // The phone folds the wide controls behind ⋯; the task manager it opens is the same modal as /tasks.
    await page.getByRole('button', { name: /^(More options|Další možnosti|Ďalšie možnosti)$/ }).click();
    await page.locator('[data-chat-popover]').getByRole('button', { name: /^(Tasks|Úkoly|Úlohy)$/ }).click();

    const dialog = page.locator('[data-elowen-modal]');
    await expect(dialog).toBeVisible();
    // It must remain the fullscreen presentation — not a bottom sheet, and not a centred desktop dialog
    // shrunk into a 390px viewport.
    await expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');

    const header = dialog.locator('h2').locator('..').locator('..');
    const body = dialog.locator('.overflow-y-auto');
    await expect(body.getByText('Task 1', { exact: true })).toBeVisible();

    // The body genuinely overflows. This is the assertion the defect failed: it reported equal heights,
    // so no amount of scrolling could ever reach the rows below the fold.
    const room = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(room, 'the task list must overflow its body rather than be compressed into it').toBeGreaterThan(0);

    const headerTop = Math.round((await header.boundingBox())!.y);

    // Scroll the way a finger does, through the input pipeline — not by writing scrollTop, which would
    // prove only that the property is writable.
    await body.hover();
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 400);

    await expect.poll(async () => body.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight),
      { message: 'the task list never reached its last row' }).toBe(true);
    await expect(body.getByText('Task 30', { exact: true })).toBeVisible();

    // The header is the fixed band the body scrolls under, so it may not travel or be squeezed with it.
    expect(Math.round((await header.boundingBox())!.y), 'the header scrolled away with the body').toBe(headerTop);
  } finally {
    await context.close();
  }
});
