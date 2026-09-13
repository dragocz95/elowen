// The Project register's card grid, measured in a real browser.
//
// WHAT IS BEING PROVEN. The register is a grid of cards whose column count follows its CONTAINER, and a
// card has to hold an exact figure like `256 MiB / 1 GiB` at whatever width three columns leave it. None
// of that is visible to jsdom: it performs no layout, so a unit test cannot tell three columns from one,
// cannot tell a label that fits from one clipped to `CP…`, and cannot tell a grid that fits its surface
// from one that overflows it and takes the page's horizontal scroll with it.
//
// The unit suites cover the wiring — which snapshot a card draws, which states it refuses to fake, what
// the team strip consumes. What is here is only what a laid-out document can answer.
import { test, expect, Seed, type Page } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';
import { adminUser } from '../seed/fixtures.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const SHOTS = process.env.E2E_SHOT_DIR ?? '/tmp/project-card-shots';

/** Six projects, mixed: enough for two full rows of three, and a slug long enough to prove a card cannot
 *  be widened by its own contents. */
const PROJECTS = [
  { id: 1, slug: 'elowen', path: '/var/www/elowen', notes: 'Osobní agent a jeho démon.', icon: '' },
  { id: 2, slug: 'autodily-jp-katalog-nahradnich-dilu', path: '/var/www/kolin', notes: 'E-shop s náhradními díly.', icon: '' },
  { id: 3, slug: 'atelier', path: '', notes: '', icon: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
  { id: 4, slug: 'sarah-hair', path: '/var/www/sarah', notes: 'Rezervace salónu.', icon: '' },
  { id: 5, slug: 'dragocz', path: '/var/www/dragocz', notes: '', icon: '' },
  { id: 6, slug: 'test-nspawn', path: '', notes: '', icon: '', executionKind: 'managed' as const, lifecycle: 'active' as const },
];

/** Administrators receive membership, which is what puts a team strip on a card at all. Eight faces is
 *  the projection's bound, and it is what makes the strip overflow a one-column card. */
const SUMMARY = PROJECTS.map((project, index) => ({
  projectId: project.id,
  members: {
    total: index === 0 ? 24 : index + 1,
    samples: Array.from({ length: index === 0 ? 16 : Math.min(index + 1, 16) }, (_, i) => ({
      id: i + 2, username: `clen${i}`, name: `Člen ${i}`, avatar: '',
    })),
  },
  ...(project.executionKind === 'managed' ? {} : { branch: index === 1 ? 'feat/velmi-dlouhy-nazev-vetve' : 'main' }),
  indicators: [],
}));

async function prepare(page: Page, seed: SeedFixture, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
  await seed.response('projects', PROJECTS);
  await seed.response('projects/summary', SUMMARY);
  await seed.response('users', [{ ...adminUser, id: 1 }]);
  await page.context().addCookies([
    { name: 'elowen-locale', value: 'cs', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    { name: 'elowen-skin', value: skin, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await page.addInitScript(() => localStorage.setItem('elowen-locale', 'cs'));
}

async function openRegister(page: Page): Promise<void> {
  await page.goto('/projects');
  await expect(page.locator('[data-project-card]').first()).toBeVisible();
  await expect(page.locator('[data-project-card]')).toHaveCount(PROJECTS.length);
}

/** How many cards share the topmost row, read from their laid-out positions rather than from a class. */
function columnCount() {
  const tops = [...document.querySelectorAll('[data-project-card]')]
    .map((card) => Math.round(card.getBoundingClientRect().top));
  const first = Math.min(...tops);
  return tops.filter((top) => Math.abs(top - first) < 2).length;
}

test.describe('the Project register card grid', () => {
  test('is three cards across on a desktop and folds to two and then one', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-light');

    // Measured, not assumed: these are the counts the container queries actually produce at each width.
    for (const [width, expected] of [[1440, 3], [1280, 3], [1024, 2], [820, 2], [768, 2], [390, 1], [320, 1]] as const) {
      await app.setViewportSize({ width, height: 900 });
      await openRegister(app);
      // Polled: the column count is a container query's answer, and the container settles a frame after
      // the viewport does.
      await expect.poll(async () => app.evaluate(columnCount), `${width}px`).toBe(expected);
    }

    await app.setViewportSize({ width: 1440, height: 900 });
    await openRegister(app);
    expect(await app.evaluate(columnCount), 'three cards across an ordinary desktop').toBe(3);
    await app.screenshot({ path: `${SHOTS}/cards-1440-light.png`, fullPage: true });
  });

  // A card may never be made wider by what is in it. A long slug, a long branch name and an exact
  // `256 MiB / 1 GiB` all have to be absorbed, or the grid pushes the page sideways.
  test('never overflows its surface, at any width', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-light');

    for (const width of [1440, 1024, 768, 390, 320]) {
      await app.setViewportSize({ width, height: 844 });
      await openRegister(app);
      const overflow = await app.evaluate(() => {
        const offenders: string[] = [];
        const document_overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        for (const card of document.querySelectorAll<HTMLElement>('[data-project-card]')) {
          // A card's own content must fit its box. The team strip is the ONE deliberate exception: it is
          // a scroll container, so its overflow is the feature.
          for (const node of card.querySelectorAll<HTMLElement>('*')) {
            if (node.closest('.project-card-team')) continue;
            // A box that HIDES or scrolls its overflow is containing it — an ellipsised slug is the
            // design. Only a box that lets its content spill is a defect, and that is what widens the
            // card, the grid and finally the page.
            if (getComputedStyle(node).overflowX !== 'visible') continue;
            if (node.scrollWidth > node.clientWidth + 1) {
              offenders.push(`${node.className || node.tagName} ${node.scrollWidth}>${node.clientWidth}`);
            }
          }
        }
        return { offenders, document_overflow };
      });
      expect(overflow.offenders, `card content overflows at ${width}px`).toEqual([]);
      expect(overflow.document_overflow, `the page scrolls sideways at ${width}px`).toBeLessThanOrEqual(1);
    }
    await app.setViewportSize({ width: 320, height: 700 });
    await openRegister(app);
    await app.screenshot({ path: `${SHOTS}/cards-320-light.png`, fullPage: true });
  });

  // The whole point of the card over the row: the exact figure has room. A resource label clipped to
  // `CP…` would mean the stacked arrangement bought nothing.
  test('keeps every resource label whole at three cards across', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-light');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openRegister(app);

    const measured = await app.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('[data-project-card]')];
      return {
        cardWidth: Math.round(cards[0]!.getBoundingClientRect().width),
        // Every always-visible identity line: the slug, the runtime pill, the branch.
        clipped: cards.flatMap((card) => [...card.querySelectorAll<HTMLElement>('[data-project-runtime], [data-metric] > span:first-child')]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map((node) => `${node.textContent} ${node.scrollWidth}>${node.clientWidth}`)),
      };
    });
    // A card narrower than this cannot hold `256 MiB / 1 GiB` beside a label, which is the geometry the
    // three-column ceiling exists to protect.
    expect(measured.cardWidth, 'a desktop card has room for its figures').toBeGreaterThanOrEqual(280);
    expect(measured.clipped, 'a resource label or runtime pill is clipped').toEqual([]);
  });

  // The card is not a control; its footer button is. That button is the card's single tab stop and has
  // to be a real touch target on a phone.
  test('opens from one named button that a finger can hit', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-light');
    await app.setViewportSize({ width: 390, height: 844 });
    await openRegister(app);

    const open = app.locator('[data-project-card]', { hasText: 'elowen' }).locator('[data-project-card-open]').first();
    await expect(open).toBeVisible();
    await expect(open).toHaveAttribute('aria-label', /elowen/);
    const box = (await open.boundingBox())!;
    expect(Math.round(box.height), 'the open control is a touch target').toBeGreaterThanOrEqual(24);

    // Keyboard: the button takes focus and shows a ring the reader can see.
    await open.focus();
    const ring = await app.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const style = getComputedStyle(element);
      return { tag: element.tagName, outline: style.outlineWidth, shadow: style.boxShadow };
    });
    expect(ring.tag).toBe('BUTTON');
    expect(ring.outline !== '0px' || ring.shadow !== 'none', 'the focused open control is visibly focused').toBe(true);

    await open.click();
    await expect(app.getByRole('dialog', { name: 'elowen' })).toBeVisible();
  });

  // A team larger than a card is wide is the case the strip exists for: it has to be reachable by
  // keyboard, and using it must not open the project underneath it.
  test('scrolls an overflowing team strip by keyboard without opening the project', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-light');
    // 320px, the narrowest width the app supports: sixteen faces are 264px and a card there leaves the
    // strip about 230px. The same team on a 390px phone fits, and the strip is correctly NOT a scroll
    // region then — it becomes one exactly when the faces do not fit.
    await app.setViewportSize({ width: 320, height: 700 });
    await openRegister(app);

    const strip = app.locator('[data-project-card]', { hasText: 'elowen' }).locator('[data-project-team="strip"]').first();
    await expect(strip).toHaveAttribute('data-project-team-overflow', 'true');
    await expect(strip).toHaveAttribute('tabindex', '0');
    await expect(strip).toHaveAttribute('role', 'group');
    // The control beside it names the WHOLE team, not the sample it could draw.
    await expect(app.locator('[data-project-card]', { hasText: 'elowen' }).locator('[data-project-team="detail"]').first())
      .toHaveAttribute('aria-label', /24/);

    await strip.focus();
    const before = await strip.evaluate((node) => node.scrollLeft);
    await app.keyboard.press('ArrowRight');
    await expect.poll(async () => strip.evaluate((node) => node.scrollLeft)).toBeGreaterThan(before);
    // Paging faces is not opening the project.
    await expect(app.getByRole('dialog', { name: 'elowen' })).toHaveCount(0);

    await app.keyboard.press('Home');
    await expect.poll(async () => strip.evaluate((node) => node.scrollLeft)).toBe(0);
    await app.screenshot({ path: `${SHOTS}/cards-team-320-light.png` });
  });

  test('carries the same geometry on the dark skin', async ({ app, seed }) => {
    test.skip(test.info().project.name !== 'authed', 'needs the authenticated shell');
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openRegister(app);
    expect(await app.evaluate(columnCount)).toBe(3);
    await app.screenshot({ path: `${SHOTS}/cards-1440-oled.png`, fullPage: true });
  });
});
