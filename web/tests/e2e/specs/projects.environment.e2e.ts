// The Environments tab of a managed project's drawer, in a real browser, driving the REAL sandbox
// plugin bundle this checkout built.
//
// WHAT IS BEING PROVEN. The plugin used to call itself by its technical id and hide the project's
// resource figures behind an "Edit resource limits" modal of bare number boxes. The figures are settings
// rows now — slider, unit, auto-save — and the change travels the plugin's own durable lifecycle action.
// Only a browser can show that the rows lay out at 390px and that dragging one actually persists, since
// the slider is a Radix widget with no layout in jsdom.
import { test, expect, Seed, type Page } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell');

const PROJECT = {
  id: 1, slug: 'atelier', path: '', notes: '', icon: '',
  executionKind: 'managed' as const, lifecycle: 'active' as const,
};

const SHOTS = process.env.E2E_SHOT_DIR ?? '/tmp/people-shots';

/** Czech, an allowed skin, and the real sandbox bundle armed. Returns false when this checkout has not
 *  built the bundle, which is a skip rather than a failure. */
async function prepare(page: Page, seed: SeedFixture, skin: 'studio-light' | 'studio-oled'): Promise<boolean> {
  const armed = await seed.realPlugins(['sandbox'], 'cs');
  if (!armed.includes('sandbox')) return false;
  await seed.response('config', { ...Seed.defaults.config, allowedSkins: ['default', 'studio-light', 'studio-oled'] });
  await seed.response('projects', [PROJECT]);
  await page.context().addCookies([
    { name: 'elowen-locale', value: 'cs', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    { name: 'elowen-skin', value: skin, domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
  ]);
  await page.addInitScript(() => localStorage.setItem('elowen-locale', 'cs'));
  return true;
}

async function openEnvironment(page: Page): Promise<void> {
  await page.goto('/projects');
  await page.locator('.data-table-row-open').first().click();
  await page.getByRole('radio', { name: 'Prostředí' }).click();
  await expect(page.getByText('Prostředky', { exact: true })).toBeVisible();
}

test.describe('managed project Environments tab', () => {
  test('states every resource with its unit and holds the rows at 390px', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    test.skip(!(await prepare(app, seed, 'studio-oled')), 'the sandbox browser bundle is not built here');

    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await app.setViewportSize(size);
      await openEnvironment(app);

      await expect(app.getByText('1 CPU')).toBeVisible();
      await expect(app.getByText('1024 MiB')).toBeVisible();
      await expect(app.getByText('512 procesů')).toBeVisible();
      await expect(app.getByText('10240 MiB')).toBeVisible();
      await expect(app.getByText('700.0 MiB')).toBeVisible(); // the reported usage, beside its threshold
      await expect(app.getByRole('slider', { name: 'Paměť' })).toBeVisible();

      const spill = await app.evaluate(() => {
        const rows = [...document.querySelectorAll('.settings-row')];
        return rows.map((row) => {
          const own = row.getBoundingClientRect();
          const parent = row.parentElement!.getBoundingClientRect();
          return Math.round(own.right - parent.right);
        });
      });
      expect(Math.max(...spill), `worst right spill at ${size.width}px`).toBeLessThanOrEqual(0);

      await app.screenshot({ path: `${SHOTS}/environment-${size.width}-oled.png` });
    }
  });

  test('auto-saves a resource change and shows the environment reporting it back', async ({ app, seed }, testInfo) => {
    authedOnly(testInfo);
    test.skip(!(await prepare(app, seed, 'studio-light')), 'the sandbox browser bundle is not built here');
    await app.setViewportSize({ width: 1440, height: 900 });
    await openEnvironment(app);

    // The write the rows make, caught on the wire: it travels the real cookie/BFF/fetch pipeline as the
    // plugin's own durable lifecycle action, and one debounced request carries BOTH steps of the drag.
    const write = app.waitForRequest((request) =>
      request.method() === 'POST' && request.url().includes('/api/plugins/sandbox/api/projects/1/environment'));

    const memory = app.getByRole('slider', { name: 'Paměť' });
    await memory.focus();
    await app.keyboard.press('ArrowRight');
    await app.keyboard.press('ArrowRight');
    await expect(app.getByText('1280 MiB')).toBeVisible();

    const body = JSON.parse((await write).postData() ?? '{}') as { action?: unknown; expectedGeneration?: number };
    expect(body.action).toEqual({ kind: 'limits', limits: { cpus: 1, memoryMb: 1280, pidsLimit: 512 } });
    expect(body.expectedGeneration).toBe(2);
    await app.screenshot({ path: `${SHOTS}/environment-saved-light.png` });
  });
});
