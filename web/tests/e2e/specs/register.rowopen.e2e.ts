// The row-open contract of a register, measured in a real browser.
//
// Opening a row is one control: a real `<button>` stretched over the whole row, carrying a SHORT
// accessible name the consumer supplies. Before that button existed the row itself was the control and
// its accessible name was its own text — on /memory that was the entire memory body, thousands of
// characters read out before the user learned what activating it would do.
//
// The button then has to live inside a `role="cell"`, because `role="row"` admits nothing else and a
// screen reader's browse mode does not expose content outside a cell — the short label would simply never
// be announced. To add that cell without moving any consumer's column template, BOTH the cell and its
// matching header are ABSOLUTELY POSITIONED: an absolutely positioned child of a grid container is not a
// grid item, so it claims no track. `pointer-events: none` on the cell with `auto` on the button is what
// lets a nested action button still be hit on its own.
//
// That is four layout assumptions stacked on each other, and jsdom can hold none of them: it performs no
// layout, so a unit test cannot tell a button that covers its row from one that collapsed to zero, and
// cannot tell a cell that claims no track from one that pushed every column sideways. Everything below is
// therefore a MEASUREMENT, taken at the four widths the app supports.
import { test, expect, type Page } from '../fixtures/index.ts';
import { adminUser } from '../seed/fixtures.ts';
import { EDITOR_PROJECT } from '../fake-daemon/handlers/pluginSurfaces.ts';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 700 },
];

/** Core registers that carry openable rows. `/projects` and `/users` serve empty by default, so they are
 *  seeded below — an empty register renders its empty state and measures nothing. */
const CORE_REGISTERS = ['/memory', '/projects', '/users'];
/** Registry-owned pages, measured only when the run is pointed at that checkout with `E2E_PLUGIN_DIRS`. */
const PLUGIN_REGISTERS = ['skills', 'stats', 'cronjob', 'mcp'];

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const users = Array.from({ length: 8 }, (_, i) => ({
  ...adminUser, id: i + 1, username: `user-${i}`, name: `User ${i}`, is_admin: i % 2 === 0,
}));
const projects = Array.from({ length: 8 }, (_, i) => ({
  ...EDITOR_PROJECT, id: i + 1, slug: `project-${i}`, path: `/srv/project-${i}`,
}));

async function openRegister(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await expect(page.locator('[role="table"] .data-table-header').first()).toBeVisible();
  await expect(page.locator('[role="row"]').nth(2)).toBeVisible();
}

/** Every register this run can actually reach, core plus whatever plugin bundles were served. */
async function reachable(seed: { realPlugins: () => Promise<string[]> }): Promise<string[]> {
  const armed = await seed.realPlugins();
  return [...CORE_REGISTERS, ...PLUGIN_REGISTERS.filter((p) => armed.includes(p)).map((p) => `/p/${p}`)];
}

/** Geometry of every register table on the page, read out of real layout. */
function measure() {
  /** What a screen reader sees. `aria-hidden` or `display:none` anywhere up to the table removes it. */
  const exposed = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if (n.getAttribute('aria-hidden') === 'true') return false;
      if (getComputedStyle(n as HTMLElement).display === 'none') return false;
      if (n.getAttribute('role') === 'table') break;
    }
    return true;
  };
  return [...document.querySelectorAll('[role="table"]')].map((table) => {
    const el = table as HTMLElement;
    const header = el.querySelector<HTMLElement>('[role="row"].data-table-header');
    const bodyRows = [...el.querySelectorAll<HTMLElement>('[role="row"]:not(.data-table-header)')];
    const button = el.querySelector<HTMLElement>('.data-table-row-open');
    const row = button?.closest('[role="row"]') as HTMLElement | null;
    const bb = button?.getBoundingClientRect();
    const rb = row?.getBoundingClientRect();
    const openCell = button?.closest('[role="cell"]') as HTMLElement | null;
    const openHeader = el.querySelector<HTMLElement>('.data-table-open-header');
    const countExposed = (r: HTMLElement | null, role: string) =>
      r ? [...r.children].filter((k) => k.getAttribute('role') === role && exposed(k)).length : null;
    return {
      label: el.getAttribute('aria-label'),
      hasOpenButton: button !== null,
      // 1. the control covers its row
      cover: bb && rb ? {
        dx: Math.round(bb.x - rb.x), dy: Math.round(bb.y - rb.y),
        dw: Math.round(bb.width - rb.width), dh: Math.round(bb.height - rb.height),
        width: Math.round(bb.width), height: Math.round(bb.height),
      } : null,
      // 2. neither half of the open column is a grid item, and both rows resolve the same tracks
      openCellPosition: openCell ? getComputedStyle(openCell).position : null,
      openCellPointerEvents: openCell ? getComputedStyle(openCell).pointerEvents : null,
      buttonPointerEvents: button ? getComputedStyle(button).pointerEvents : null,
      openHeaderPosition: openHeader ? getComputedStyle(openHeader).position : null,
      headerTracks: header ? getComputedStyle(header).gridTemplateColumns : null,
      bodyTracks: bodyRows[0] ? getComputedStyle(bodyRows[0]).gridTemplateColumns : null,
      // 3. header and body agree on the column count in the ACCESSIBILITY tree
      headerColumns: countExposed(header, 'columnheader'),
      bodyCells: countExposed(bodyRows[0] ?? null, 'cell'),
      // an extra grid item would wrap onto an implicit second row, which shows up as height
      standardHeights: [...new Set(bodyRows.filter((r) => r.dataset.rowHeight !== 'tall')
        .map((r) => Math.round(r.getBoundingClientRect().height)))],
      // 5. the accessible name is the caller's short label, and it lives inside a cell
      label_: button?.getAttribute('aria-label') ?? null,
      buttonInCell: openCell !== null,
      buttonInRow: button?.closest('[role="row"]') !== null,
    };
  });
}

test('the row-open control covers its row and claims no column at any width', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  // Many navigations rather than one slow page; the widths are the point of the case.
  test.setTimeout(300_000);
  await seed.response('users', users);
  await seed.response('projects', projects);
  const routes = await reachable(seed);

  for (const size of VIEWPORTS) {
    await app.setViewportSize(size);
    for (const route of routes) {
      await openRegister(app, route);
      for (const t of await app.evaluate(measure)) {
        const where = `${route} "${t.label}" at ${size.width}px`;
        if (!t.hasOpenButton) continue;

        // 1. It covers the row. A residual grid track, or a collapse to zero, is the failure this whole
        //    case exists for — the button is `position: absolute; inset: 0` inside a cell that is the
        //    same, so it must land exactly on the row's padding box. The row's 1px bottom border is
        //    outside that box, which is the only allowed shortfall.
        expect(t.cover!.dx, `${where}: open control is offset horizontally`).toBe(0);
        expect(t.cover!.dy, `${where}: open control is offset vertically`).toBe(0);
        expect(t.cover!.dw, `${where}: open control is not the row's full width`).toBe(0);
        expect(t.cover!.dh, `${where}: open control is not the row's full height`).toBeGreaterThanOrEqual(-1);
        expect(t.cover!.dh, `${where}: open control is TALLER than its row`).toBeLessThanOrEqual(0);
        expect(t.cover!.width, `${where}: open control collapsed`).toBeGreaterThan(0);
        expect(t.cover!.height, `${where}: open control collapsed`).toBeGreaterThan(0);

        // 2. Neither half of the column is a grid item, so no consumer's template moved: the header and
        //    the body rows have to resolve to the SAME track list. A cell that claimed a track would
        //    push the last column out of the header or wrap onto an implicit second row.
        expect(t.openCellPosition, `${where}: the open cell is a grid item`).toBe('absolute');
        expect(t.openHeaderPosition, `${where}: the open header is a grid item`).toBe('absolute');
        expect(t.bodyTracks, `${where}: the body row's columns do not match the header's`).toBe(t.headerTracks);
        expect(t.standardHeights, `${where}: rows wrapped onto a second grid row`).toHaveLength(1);

        // The pointer contract, and it is easy to invert: the cell covers the row so it must not take
        // pointer events, while the button inside it must.
        expect(t.openCellPointerEvents, `${where}: the open cell swallows pointer events`).toBe('none');
        expect(t.buttonPointerEvents, `${where}: the open control takes no pointer events`).toBe('auto');

        // 3. Header and body agree on the column count in the accessibility tree. A column hidden on one
        //    side only makes a screen reader read every later column against the wrong name.
        expect(t.bodyCells, `${where}: body row and header row expose different column counts`)
          .toBe(t.headerColumns);

        // 5. The accessible name is the caller's short label, inside a cell, inside the row.
        expect(t.buttonInCell, `${where}: the open control is not inside a role="cell"`).toBe(true);
        expect(t.buttonInRow, `${where}: the open control escaped its row`).toBe(true);
        expect(t.label_, `${where}: the open control has no accessible name`).toBeTruthy();
        // Short: the defect was the row's whole text becoming the name. The excerpt is bounded.
        expect(t.label_!.length, `${where}: the open control's name is the row's body again`).toBeLessThan(120);
      }
    }
  }
});

test('a row opens on a real click, and a nested action fires alone', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.setTimeout(300_000);
  await seed.response('users', users);
  // `/memory`'s nested control is a selection checkbox, `/users`'s is a row ActionMenu — the two shapes
  // a register puts inside a row. Both must win the hit test against an overlay that covers them.
  const detailOpen = () =>
    document.querySelector<HTMLElement>('.workspace-master-detail')?.dataset.detail === 'true';

  for (const size of VIEWPORTS) {
    await app.setViewportSize(size);
    for (const route of ['/memory', '/users']) {
      await openRegister(app, route);
      const row = app.locator('[role="row"]:not(.data-table-header)').first();
      await row.scrollIntoViewIfNeeded();
      const box = (await row.boundingBox())!;
      // No `force`, and no synthetic event: this has to succeed through real hit-testing.
      await app.mouse.click(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
      expect(await app.evaluate(detailOpen), `${route} at ${size.width}px: clicking a row does not open it`)
        .toBe(true);

      // The other direction, which the same `pointer-events` pair decides and which an inverted rule
      // would break silently: the nested control is hit, and the row does NOT also open behind it.
      await openRegister(app, route);
      const nested = app.locator('[role="row"]:not(.data-table-header)').first().getByRole('button').first();
      await nested.scrollIntoViewIfNeeded();
      const nb = (await nested.boundingBox())!;
      const under = await app.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('.data-table-row-open') !== null ? 'ROW-OPEN' : 'THE NESTED CONTROL';
      }, [Math.round(nb.x + nb.width / 2), Math.round(nb.y + nb.height / 2)] as [number, number]);
      expect(under, `${route} at ${size.width}px: the overlay covers a nested action button`)
        .toBe('THE NESTED CONTROL');

      await app.mouse.click(Math.round(nb.x + nb.width / 2), Math.round(nb.y + nb.height / 2));
      expect(await app.evaluate(detailOpen), `${route} at ${size.width}px: a nested action also opened the row`)
        .toBe(false);
    }
  }
});

test('the row opens from the keyboard, and its nested action stays reachable', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const detailOpen = () =>
    document.querySelector<HTMLElement>('.workspace-master-detail')?.dataset.detail === 'true';
  await seed.response('users', users);

  for (const key of ['Enter', 'Space']) {
    await openRegister(app, '/memory');
    const open = app.getByRole('button', { name: /^Open memory:/ }).first();
    // Reachable by role AND name is the point of the contract: the label is what a screen reader user
    // hears, so it has to be the thing that identifies the control.
    await expect(open).toHaveCount(1);
    await open.focus();
    expect(await app.evaluate(() => document.activeElement?.classList.contains('data-table-row-open')),
      'focus did not land on the row-open control').toBe(true);
    // A real `<button>` gives Enter and Space for free; a div with a keydown handler is what this
    // replaced, and it is what silently loses one of the two.
    await app.keyboard.press(key);
    expect(await app.evaluate(detailOpen), `${key} does not open the row`).toBe(true);
  }

  // One tab stop for opening the row, and the nested action is still its own stop — a row that swallowed
  // its checkbox into a single control would make the selection unreachable from the keyboard.
  await openRegister(app, '/memory');
  const stops = await app.locator('[role="row"]:not(.data-table-header)').first().evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
      .filter((n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled)
      .map((n) => (n.classList.contains('data-table-row-open') ? 'row-open' : 'nested')));
  expect(stops.filter((s) => s === 'row-open'), 'a row must offer exactly one open control').toHaveLength(1);
  expect(stops.filter((s) => s === 'nested').length, 'the row action is no longer focusable')
    .toBeGreaterThan(0);
  // The row itself is not a tab stop; the button inside it is.
  expect(await app.locator('[role="row"]:not(.data-table-header)').first().evaluate((el) => el.tabIndex),
    'the row element competes with its own open control for focus').toBe(-1);
});
