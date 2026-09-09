// The People tab of a managed project's drawer, in a real browser.
//
// WHAT IS BEING PROVEN. The tab used to print "Account 15" — a bare number — for people who share every
// file and stored credential in the project's environment, above a raw numeric ID box and a full-width
// Invite button. It now renders the identity the daemon's member projection carries, and an
// administrator adds members through the shared account picker instead of typing an id.
//
// jsdom already covers the wiring (tests/modules/projects/ManagedProjectMembers.test.tsx). What only a
// browser can answer is whether the row survives a 390px column and whether the picker is reachable and
// dismissable from the keyboard, so everything here is measured or driven, never mocked in the page.
import { test, expect, Seed, type Page } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';
import { adminUser } from '../seed/fixtures.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const PROJECT = {
  id: 1, slug: 'atelier', path: '', notes: '', icon: '',
  executionKind: 'managed' as const, lifecycle: 'active' as const,
};
const MEMBERS = [
  { id: 1, username: 'admin', name: 'E2E Admin', email: 'admin@example.test', avatar: '' },
  { id: 15, username: 'dana', name: 'Dana Nováková', email: 'dana.novakova@example.test', avatar: '' },
];
const DIRECTORY = [
  { ...adminUser, id: 1 },
  { ...adminUser, id: 15, username: 'dana', name: 'Dana Nováková', email: 'dana.novakova@example.test', is_admin: false },
  { ...adminUser, id: 16, username: 'petr', name: 'Petr Malý', email: 'petr.maly@example.test', is_admin: false },
];

/** Czech, and a skin the instance actually allows. Both halves are needed: `resolveSkin()` drops a
 *  choice that is not on the instance list back to the operator default. */
async function prepare(page: Page, seed: SeedFixture, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
  await seed.response('projects', [PROJECT]);
  await seed.response('projects/members', MEMBERS);
  await seed.response('users', DIRECTORY);
  await page.context().addCookies([
    { name: 'elowen-locale', value: 'cs', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    { name: 'elowen-skin', value: skin, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await page.addInitScript(() => localStorage.setItem('elowen-locale', 'cs'));
}

/** Open the project drawer and switch to its People tab. */
async function openPeople(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.locator('.data-table-row-open').first().click();
  await page.getByRole('radio', { name: 'Lidé' }).click();
  await expect(page.getByText('Dana Nováková')).toBeVisible();
}

test.describe('managed project People tab', () => {
  test('names every member and keeps the row intact down to 390px', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');

    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await app.setViewportSize(size);
      await openPeople(app);

      // The identity, not the number. The account id survives only inside the invite copy, never as
      // the name of a person.
      await expect(app.getByText('Dana Nováková')).toBeVisible();
      await expect(app.getByText('@dana · dana.novakova@example.test')).toBeVisible();
      await expect(app.getByText('Účet 15', { exact: true })).toHaveCount(0);
      await expect(app.getByLabel('Dana Nováková')).toBeVisible();
      await expect(app.getByText('Počet členů: 2')).toBeVisible();

      // Nothing in the row may spill out of the drawer column at any width.
      const overflow = await app.evaluate(() => {
        const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('Dana Nováková'));
        if (!row) return null;
        const parent = row.parentElement!.getBoundingClientRect();
        const own = row.getBoundingClientRect();
        return { spillRight: Math.round(own.right - parent.right), spillLeft: Math.round(parent.left - own.left), height: Math.round(own.height) };
      });
      expect(overflow, `row geometry at ${size.width}px`).not.toBeNull();
      expect(overflow!.spillRight, `right spill at ${size.width}px`).toBeLessThanOrEqual(0);
      expect(overflow!.spillLeft, `left spill at ${size.width}px`).toBeLessThanOrEqual(0);

      await app.screenshot({ path: `${process.env.E2E_SHOT_DIR ?? '/tmp/people-shots'}/people-${size.width}-oled.png` });
    }
  });

  test('opens and dismisses the account picker from the keyboard', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openPeople(app);

    const add = app.getByRole('button', { name: 'Přidat členy' });
    await expect(add).toBeEnabled();
    await add.focus();
    await app.keyboard.press('Enter');

    // Named, because the drawer this modal opens inside is itself a dialog.
    const picker = app.getByRole('dialog', { name: 'Přidání členů projektu' });
    await expect(picker).toBeVisible();
    // Only accounts that are not members yet, and never an administrator whose access needs no row.
    await expect(picker.getByText('Petr Malý')).toBeVisible();
    await expect(picker.getByText('Dana Nováková')).toHaveCount(0);
    await app.screenshot({ path: `${process.env.E2E_SHOT_DIR ?? '/tmp/people-shots'}/people-picker-oled.png` });

    await app.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    // The tab underneath is usable again, not left inert by the overlay stack.
    await expect(add).toBeEnabled();
  });

  test('reads correctly in the light skin', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-light');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openPeople(app);

    await expect(app.getByText('@dana · dana.novakova@example.test')).toBeVisible();
    await app.screenshot({ path: `${process.env.E2E_SHOT_DIR ?? '/tmp/people-shots'}/people-1440-light.png` });
  });
});
