// A managed project's basic actions and its Overview, in a real browser.
//
// WHAT IS BEING PROVEN. Three places treated a managed project as a different kind of record: its
// removal lived in a red button inside the environment panel instead of the action menu every project
// has, its Overview read nothing until an "Inspect repository" button was pressed, and it was not
// allowed to choose an icon at all. jsdom covers the wiring; what a browser adds here is that the menu
// really is the same menu, and that opening Overview issues the request by itself.
import { test, expect, Seed, type Page } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const MANAGED = { id: 1, slug: 'atelier', path: '', notes: 'Poznámky k projektu', icon: '', executionKind: 'managed' as const, lifecycle: 'active' as const };
const HOST = { id: 2, slug: 'hostitel', path: '/var/www/hostitel', notes: '', icon: '' };
const SHOTS = process.env.E2E_SHOT_DIR ?? '/tmp/people-shots';

async function prepare(page: Page, seed: SeedFixture, skin: 'studio-light' | 'studio-oled'): Promise<void> {
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
  await seed.response('projects', [MANAGED, HOST]);
  await page.context().addCookies([
    { name: 'elowen-locale', value: 'cs', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    { name: 'elowen-skin', value: skin, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await page.addInitScript(() => localStorage.setItem('elowen-locale', 'cs'));
}

/** The labels of one project's action menu, in order. */
async function menuOf(page: Page, slug: string): Promise<string[]> {
  await page.getByRole('button', { name: `${slug}: Akce` }).click();
  const labels = await page.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  return labels.map((label) => label.trim());
}

test.describe('managed project parity', () => {
  test('offers removal in the same action menu a host project uses', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });
    await app.goto('/projects');
    await expect(app.getByText('atelier')).toBeVisible();

    const managed = await menuOf(app, 'atelier');
    const host = await menuOf(app, 'hostitel');

    expect(managed, 'the managed menu offers removal').toContain('Odebrat projekt');
    expect(host, 'the host menu offers removal').toContain('Odebrat projekt');
    // The same menu, item for item, in the same order. A managed project has no host path, but it has
    // the guest root its own executions work from, so even Copy path is the same action.
    expect(managed).toEqual(host);

    // And the confirmation tells a managed project the truth about its environment.
    await app.getByRole('button', { name: 'atelier: Akce' }).click();
    await app.getByRole('menuitem', { name: 'Odebrat projekt' }).click();
    const confirm = app.getByRole('alertdialog');
    await expect(confirm.getByText(/prostředí/)).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/managed-remove-confirm-oled.png` });
    await app.getByRole('button', { name: 'Zrušit' }).click();
  });

  test('reads the repository when Overview opens, with nothing to press first', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    await prepare(app, seed, 'studio-oled');
    await app.setViewportSize({ width: 1440, height: 900 });

    const read = app.waitForRequest((request) => request.url().includes('/api/projects/1/git'));
    await app.goto('/projects');
    await app.locator('[role="row"]', { hasText: 'atelier' }).locator('.data-table-row-open').first().click();

    // What the register already holds is on screen while the repository read is still in flight.
    await expect(app.getByText('Poznámky k projektu')).toBeVisible();
    await read;
    await expect(app.getByRole('button', { name: /Prohlédnout repozitář/ })).toHaveCount(0);
    // The fake daemon serves no repository for this project, and that is a plain statement, not a prompt
    // to create one.
    await expect(app.getByText('Není git repozitář')).toBeVisible();
    await expect(app.getByRole('button', { name: /repozitář/i })).toHaveCount(0);
    await app.screenshot({ path: `${SHOTS}/managed-overview-oled.png` });
  });

  test('sets a managed project icon from a file inside its environment', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    // The picker and the rendered icon both go through the editor plugin's project file routes, which
    // read a managed project through the guest filesystem. Without that plugin there is no picker to
    // drive, so the spec uses the real built bundle rather than a fixture standing in for it.
    // The editor lives in the plugin registry, not this repo, so point the harness at that checkout:
    // E2E_PLUGIN_DIRS=/path/to/elowen-plugins/plugins
    const armed = await seed.realPlugins(['editor'], 'cs');
    test.skip(!armed.includes('editor'), 'set E2E_PLUGIN_DIRS to a checkout that ships the editor bundle');
    await prepare(app, seed, 'studio-oled');
    // Files as the guest reports them: project-relative, with no host prefix anywhere.
    await app.route('**/api/projects/1/files*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify([{ path: 'docs/logo.png', type: 'file' }, { path: 'src/index.ts', type: 'file' }]),
    }));
    // The bytes the editor's raw route reads out of the guest, so the tile renders a real image.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await app.route('**/api/projects/1/raw*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    let saved: unknown = null;
    await app.route('**/api/projects/1', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      saved = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...MANAGED, icon: 'docs/logo.png' }) });
    });
    await app.setViewportSize({ width: 1440, height: 900 });
    await app.goto('/projects');

    await app.getByRole('button', { name: 'atelier: Akce' }).click();
    await app.getByRole('menuitem', { name: 'Upravit projekt' }).click();
    const choose = app.locator('button', { hasText: 'Vybrat ikonku' });
    await expect(choose).toBeVisible();
    await choose.click();

    // The guest's own files, offered by directory exactly as for a host project.
    await expect(app.getByText('docs')).toBeVisible();
    const candidate = app.locator('button[title="docs/logo.png"]');
    await expect(candidate).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/managed-icon-picker-oled.png` });
    await candidate.click();
    await expect(candidate).toHaveAttribute('aria-pressed', 'true');
    // The preview is the guest's own file, fetched and decoded rather than a placeholder.
    await expect.poll(async () => candidate.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    await app.getByRole('button', { name: 'Vybrat', exact: true }).click();

    // The stored icon is the project-relative guest path, never a host location.
    await expect.poll(() => saved).toEqual({ icon: 'docs/logo.png' });
    await expect(app.getByText('Ikonka nastavena')).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/managed-icon-set-oled.png` });
  });
});
