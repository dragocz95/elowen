// The command palette, driven the way a person drives it: a pointer on the visible trigger.
//
// A review pass reported the palette as dead in every design — no shortcut, no event. It is not: driving
// it in Chrome opens it from the button, from Ctrl+K and from its window event alike. What that pass
// actually hit was an unrelated render crash on `/dash`, which tears the React tree down and takes every
// window listener in the app with it, after which nothing responds to anything.
//
// So this spec exists to keep the report from being true LATER. The trigger sits in `TopBar`, which is
// shared chrome on every design, and the palette is mounted once in `ShellLayout` — a skin that broke
// either would ship a visible control that does nothing. It is asserted through the POINTER because the
// keyboard path was never the one at risk: only a click proves the button is reachable, hit-testable and
// wired, and only running it in Studio proves Studio's own stylesheets have not buried the overlay.
import { test, expect, type Page } from '../fixtures/index.ts';
import { Seed } from '../fixtures/Seed.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

/** A page carrying a table and a toolbar, so the palette has real page chrome to open over. */
const ROUTE = '/memory';

/** Ember is the ABSENCE of a `data-skin` attribute, not a skin — so the default design is `null` here. */
const DESIGNS = [null, 'studio-light', 'studio-oled'] as const;

/** Put the context into a compiled skin. Both halves are required: the cookie is what the account asked
 *  for, the instance allow-list is what it may have, and `resolveSkin()` drops a choice that is not on
 *  the list back to the operator default — so a spec that only sets the cookie measures Ember and passes
 *  for the wrong reason. See `studio.viewport.e2e.ts`, where this is explained at length. */
async function useSkin(page: Page, seed: Seed, skin: string): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'midnight', 'studio-light', 'studio-oled'] });
  const url = new URL(page.url() === 'about:blank' ? 'http://127.0.0.1' : page.url());
  await page.context().addCookies([{ name: 'elowen-skin', value: skin, domain: url.hostname, path: '/', sameSite: 'Lax' }]);
}

/** Open a route and confirm the document really arrived wearing the design under test. The harness runs
 *  `next dev`, so the first hit on a cold route compiles it, and a layout whose config fetch loses that
 *  race resolves the allow-list to null and serves the operator default (web/lib/serverPrefetch.ts). The
 *  navigation is therefore retried rather than the assertion loosened. */
async function openDesign(page: Page, route: string, skin: string | null): Promise<void> {
  await expect(async () => {
    await page.goto(route);
    expect(await page.locator('html').getAttribute('data-skin')).toBe(skin);
  }).toPass({ timeout: 20_000 });
  await expect(page.locator('h1')).toBeVisible();
}

for (const skin of DESIGNS) {
  test(`the command palette opens from its visible trigger — ${skin ?? 'default'}`, async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    if (skin) await useSkin(app, seed, skin);
    await openDesign(app, ROUTE, skin);

    const trigger = app.getByRole('button', { name: 'Open command palette' });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // A real dialog now, not an anonymous div: the palette renders through the shadcn `Dialog`, so Radix
    // announces it and traps focus in it while the app's overlay stack isolates the page behind it.
    const dialog = app.getByRole('dialog', { name: 'Open command palette' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox', { name: 'Search commands…' });
    await expect(input).toBeFocused();

    // Typing narrows the list, and the surviving row is the one Enter will run.
    await input.fill('projects');
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(dialog.getByRole('option')).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');

    await expect(app).toHaveURL(/\/projects$/);
    await expect(dialog).toBeHidden();
  });
}

test('closing the palette returns focus to the control that opened it', async ({ app }, testInfo) => {
  authedOnly(testInfo);
  await openDesign(app, ROUTE, null);
  const trigger = app.getByRole('button', { name: 'Open command palette' });
  await trigger.click();
  await expect(app.getByRole('dialog', { name: 'Open command palette' })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByRole('dialog', { name: 'Open command palette' })).toBeHidden();
  await expect(trigger).toBeFocused();
});
