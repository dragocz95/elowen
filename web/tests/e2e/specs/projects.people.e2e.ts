// A managed project's People tab beside a host project's, in a real browser.
//
// WHAT IS BEING PROVEN. The managed tab used to be a roster of its own: a heading, a paragraph and one
// removable row per person, where a host project showed a one-line access summary with a Manage button.
// A project is the same kind of record whichever way it runs, so the two tabs are now the same surface
// built from the same components, and this spec measures them against each other rather than describing
// each separately. jsdom covers the wiring; only a browser can compare the two layouts and tell whether
// the summary survives a 390px column.
import { test, expect, Seed, type Page } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';
import { adminUser } from '../seed/fixtures.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const MANAGED = { id: 1, slug: 'atelier', path: '', notes: '', icon: '', executionKind: 'managed' as const, lifecycle: 'active' as const };
const HOST = { id: 2, slug: 'hostitel', path: '/var/www/hostitel', notes: '', icon: '' };
const MEMBERS = [
  { id: 1, username: 'admin', name: 'E2E Admin', email: 'admin@example.test', avatar: '' },
  { id: 15, username: 'dana', name: 'Dana Nováková', email: 'dana.novakova@example.test', avatar: '' },
];
const DIRECTORY = [
  { ...adminUser, id: 1 },
  { ...adminUser, id: 15, username: 'dana', name: 'Dana Nováková', email: 'dana.novakova@example.test', is_admin: false },
  { ...adminUser, id: 16, username: 'petr', name: 'Petr Malý', email: 'petr.maly@example.test', is_admin: false },
];

const SHOTS = process.env.E2E_SHOT_DIR ?? '/tmp/people-shots';

/** Czech, and a skin the instance actually allows. Both halves are needed: `resolveSkin()` drops a
 *  choice that is not on the instance list back to the operator default. */
async function prepare(page: Page, seed: SeedFixture, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
  await seed.response('projects', [MANAGED, HOST]);
  await seed.response('projects/members', MEMBERS);
  await seed.response('users', DIRECTORY);
  await page.context().addCookies([
    { name: 'elowen-locale', value: 'cs', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    { name: 'elowen-skin', value: skin, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await page.addInitScript(() => localStorage.setItem('elowen-locale', 'cs'));
}

/** Open one project's drawer and switch to its People tab. */
async function openPeople(page: Page, slug: string): Promise<void> {
  await page.goto('/projects');
  await page.locator('[role="row"]', { hasText: slug }).locator('.data-table-row-open').first().click();
  await page.getByRole('radio', { name: 'Lidé' }).click();
  await expect(page.getByRole('button', { name: 'Spravovat' })).toBeVisible();
}

/** The measurable shape of the tab: what the summary says, and the band it occupies. */
async function surfaceOf(page: Page): Promise<{ count: string; box: { height: number; width: number } }> {
  const card = page.getByRole('button', { name: 'Spravovat' }).locator('xpath=..');
  const box = (await card.boundingBox())!;
  return {
    // The first line is the count sentence; the avatar chips follow it.
    count: (await card.innerText()).split('\n')[0]!.trim(),
    box: { height: Math.round(box.height), width: Math.round(box.width) },
  };
}

test.describe('managed and host People tabs', () => {
  test('shows a managed project the same access summary a host project shows', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });

    await openPeople(app, 'hostitel');
    const host = await surfaceOf(app);
    await openPeople(app, 'atelier');
    const managed = await surfaceOf(app);

    // The same sentence and the same control, occupying the same band.
    expect(managed.count, 'the managed count line').toMatch(/^\d+ z \d+ uživatelů má přístup$/);
    expect(host.count, 'the host count line').toMatch(/^\d+ z \d+ uživatelů má přístup$/);
    expect(Math.abs(managed.box.height - host.box.height), 'summary heights differ').toBeLessThanOrEqual(2);
    expect(Math.abs(managed.box.width - host.box.width), 'summary widths differ').toBeLessThanOrEqual(2);

    // The roster the managed tab used to draw is gone: no per-person removal button beside the summary.
    await expect(app.getByRole('button', { name: 'Odebrat člena' })).toHaveCount(0);
    // The shared-memory row still sits underneath it, as it does for a host project.
    await expect(app.getByText('Sdílená paměť')).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/people-managed-1440-oled.png` });
  });

  test('holds the summary inside the drawer at 390px', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 390, height: 844 });
    await openPeople(app, 'atelier');

    const spill = await app.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Spravovat');
      const card = button?.parentElement;
      if (!card) return null;
      const own = card.getBoundingClientRect();
      const parent = card.parentElement!.getBoundingClientRect();
      return { right: Math.round(own.right - parent.right), left: Math.round(parent.left - own.left) };
    });
    expect(spill, 'the access summary is on screen').not.toBeNull();
    expect(spill!.right, 'right spill at 390px').toBeLessThanOrEqual(0);
    expect(spill!.left, 'left spill at 390px').toBeLessThanOrEqual(0);
    await app.screenshot({ path: `${SHOTS}/people-managed-390-oled.png` });
  });

  test('opens and dismisses the shared account picker from the keyboard', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openPeople(app, 'atelier');

    const manage = app.getByRole('button', { name: 'Spravovat' });
    await manage.focus();
    await app.keyboard.press('Enter');

    // Named, because the drawer this modal opens inside is itself a dialog.
    const picker = app.getByRole('dialog', { name: 'Přístup uživatelů' });
    await expect(picker).toBeVisible();
    // Identity, with the handle and the address the shared picker shows everywhere.
    await expect(picker.getByText('Dana Nováková')).toBeVisible();
    await expect(picker.getByText('dana.novakova@example.test')).toBeVisible();
    // And the consequence of membership in a managed project is stated where the decision is made.
    await expect(picker.getByText(/přihlašovacím údajům/)).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/people-managed-picker-oled.png` });

    await app.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(manage).toBeEnabled();
  });

  test('reads correctly in the light skin', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-light');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openPeople(app, 'atelier');

    await expect(app.getByRole('button', { name: 'Spravovat' })).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/people-managed-1440-light.png` });
  });
});
