import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '../fixtures/index.ts';
import { STORAGE_STATE } from '../../../playwright.config.ts';

/** The Agents page in a real browser: the register alone, and one built-in agent's detail rail carrying
 *  the model that agent runs on for this account. It exists to SHOW the layout at both measures — the
 *  panel this replaced looked correct in jsdom and read as a locked settings block on screen.
 *
 *  The two per-account endpoints the page needs are not part of the fake daemon's canned surface, so they
 *  are fulfilled per request here; everything else (the shell, the bundle, the plugin listing) is the
 *  real pipeline. */

// Outside the checkout by default, like the project-card shots: these are review artefacts of a run,
// not fixtures the repository carries.
const SHOTS = process.env.E2E_SHOT_DIR ?? '/tmp/subagent-drawer-shots';

const AGENTS = [
  { name: 'explore', description: 'Read-only codebase exploration and search — finds files, traces code paths and gathers conclusions across many files.', tools: 'read-only', source: 'builtin', canDelete: false },
  { name: 'plan', description: 'Exploration that designs an implementation plan — researches the codebase and writes the plan to a file.', tools: 'inherit', source: 'builtin', canDelete: false },
  { name: 'review', description: 'Adversarial code review of a change before it merges — reads the diff, the tests and the surrounding code.', tools: 'read-only', source: 'builtin', canDelete: false },
];

const MODELS = [
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-sonnet-5', exec: 'anthropic/claude-sonnet-5', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
  { provider: 'anthropic', providerLabel: 'Anthropic', model: 'claude-opus-4', exec: 'anthropic/claude-opus-4', source: 'api-key', contextWindow: 200000, contextWindowSet: false },
  { provider: 'openai', providerLabel: 'OpenAI', model: 'gpt-5', exec: 'openai/gpt-5', source: 'api-key', contextWindow: 400000, contextWindowSet: false },
];

/** The account's own plugin settings, kept per page so a save in the browser is visible on reopen. */
async function stubAccountEndpoints(page: Page): Promise<void> {
  let config: Record<string, unknown> = {};
  let revision = 0;
  await page.route('**/api/plugins/agents/list', (route) =>
    route.fulfill({ json: AGENTS }));
  await page.route('**/api/plugins/user-config', (route) =>
    route.fulfill({ json: [{ name: 'subagent', label: 'Agents', userConfigSchema: [], config, secretsSet: [], revision, placement: 'pluginPage' }] }));
  await page.route('**/api/plugins/subagent/user-config', async (route) => {
    const body = route.request().postDataJSON() as { values?: Record<string, unknown> };
    config = { ...body.values };
    revision += 1;
    await route.fulfill({ json: { name: 'subagent', userConfigSchema: [], config, secretsSet: [], revision, placement: 'pluginPage' } });
  });
}

/** The rail animates in. A screenshot taken before it settles shows a half-transparent drawer over the
 *  register, which is a picture of the transition rather than of the layout. */
async function settled(dialog: ReturnType<Page['getByRole']>): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS('opacity', '1');
}

async function openAgentsPage(page: Page): Promise<void> {
  await page.goto('/p/subagent');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('[role="table"] .data-table-header')).toBeVisible();
}

test.describe('the Agents page and its model drawer', () => {
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

  test('shows the register alone and sets a model inside the agent\'s own rail @shots', async ({ app, seed }, testInfo) => {
    test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');
    const armed = await seed.realPlugins(['subagent']);
    test.skip(!armed.includes('subagent'), 'the subagent bundle is not built in this checkout');
    await seed.response('brain/models', MODELS);
    await stubAccountEndpoints(app);

    await openAgentsPage(app);
    // Nothing above the register: no model panel restating the same three agents.
    await expect(app.getByRole('button', { name: /^Model: / })).toHaveCount(0);
    await app.screenshot({ path: `${SHOTS}/agents-desktop-register.png`, fullPage: true });

    await app.getByRole('button', { name: 'Open entry: explore' }).click();
    const rail = app.getByRole('dialog');
    await settled(rail);
    const picker = rail.getByRole('button', { name: 'Model: explore' });
    await expect(picker).toBeEnabled();
    await app.screenshot({ path: `${SHOTS}/agents-desktop-drawer.png` });

    await picker.click();
    const chooser = app.getByRole('dialog').last();
    await settled(chooser);
    await expect(chooser.getByRole('button', { name: 'claude-opus-4' })).toBeVisible();
    await app.screenshot({ path: `${SHOTS}/agents-desktop-picker.png` });
    await chooser.getByRole('button', { name: 'claude-opus-4' }).click();
    await chooser.getByRole('button', { name: 'Save changes' }).click();
    await expect(rail.getByRole('button', { name: 'Model: explore' })).toContainText('claude-opus-4');
    await app.screenshot({ path: `${SHOTS}/agents-desktop-selected.png` });
  });

  test('lays the same rail out on a phone @shots', async ({ browser, seed }, testInfo) => {
    test.skip(testInfo.project.name !== 'authed', 'needs the authenticated shell that hosts plugin pages');
    const armed = await seed.realPlugins(['subagent']);
    test.skip(!armed.includes('subagent'), 'the subagent bundle is not built in this checkout');
    await seed.response('brain/models', MODELS);

    const context = await browser.newContext({
      storageState: STORAGE_STATE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await stubAccountEndpoints(page);
    await openAgentsPage(page);
    await page.screenshot({ path: `${SHOTS}/agents-mobile-register.png`, fullPage: true });

    await page.getByRole('button', { name: 'Open entry: explore' }).click();
    const rail = page.getByRole('dialog');
    await settled(rail);
    await expect(rail.getByRole('button', { name: 'Model: explore' })).toBeEnabled();
    await page.screenshot({ path: `${SHOTS}/agents-mobile-drawer.png` });
    await context.close();
  });
});
