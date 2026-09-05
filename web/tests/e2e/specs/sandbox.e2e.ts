// The `/sandbox` slash command in a real browser, end to end through the generic plugin-picker path.
//
// WHAT IS BEING PROVEN. The command is not built into the web at all: the sandbox PLUGIN publishes it
// (`kind:'picker'`, `execution:'surface-local'`, `plugin:'sandbox'`), the daemon announces it in
// `GET /brain/commands`, and `pluginPickers.tsx` is the only thing that says this build can draw it. So
// every assertion here starts from the CATALOG — seed the entry, type the command, and see the drawer.
// The last test removes the entry and shows the drawer stays shut, which is the disabled-plugin case.
//
// The fake daemon answers the plugin's own routes from `fake-daemon/handlers/sandbox.ts`, with state:
// two projects, a clean workspace bound to this conversation and a dirty one whose removal the daemon
// refuses with the plugin's coded `workspace_not_clean`. Nothing is mocked in the browser — the writes
// travel the real cookie / BFF / fetch pipeline and come back as the drawer's next render.
import { test, expect, ChatPage, SandboxDrawer, SANDBOX_TEXT, Seed } from '../fixtures/index.ts';
import type { Seed as SeedFixture } from '../fixtures/Seed.ts';
import type { Page } from '@playwright/test';
import type { SlashCommandDef } from '../../../lib/types.ts';
import { DEFAULT_SESSION_ID } from '../seed/fixtures.ts';
import { DAEMON_URL } from '../fixtures/env.ts';
import { DIRTY_WORKSPACE_ID } from '../fake-daemon/handlers/sandbox.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated chat');

const CLEAN_LABEL = 'payment refactor';
const DIRTY_LABEL = 'catalog spike';

/** Exactly what the sandbox plugin registers (plugins/sandbox/index.mjs) and the daemon republishes. */
const SANDBOX_COMMAND: SlashCommandDef = {
  name: 'sandbox',
  description: 'Inspect and manage Sandbox workspaces',
  kind: 'picker',
  execution: 'surface-local',
  plugin: 'sandbox',
  surfaces: ['cli', 'web'],
};

/** Open `/chat` with the sandbox command in the catalog and an empty transcript. */
async function chatWithSandbox(app: Page, seed: SeedFixture): Promise<ChatPage> {
  await seed.brainCommands([...Seed.defaults.brainCommands, SANDBOX_COMMAND]);
  await seed.messages([]);
  const chat = new ChatPage(app);
  await chat.goto();
  return chat;
}

/** Type the command and submit it, which is the path a reader takes. */
async function runSandboxCommand(chat: ChatPage): Promise<void> {
  await chat.type('/sandbox');
  await chat.submitWithEnter();
}

test('@smoke /sandbox opens the plugin-contributed drawer and states every workspace', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);

  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();
  // With room and nothing open beneath it, the house rule resolves the first overlay to a right-hand drawer.
  expect(await drawer.presentation()).toBe('drawer');

  // Both worktrees, grouped under the repository each was cut from.
  await expect(drawer.rows()).toHaveCount(2);
  await expect(drawer.group('atlas')).toBeVisible();
  await expect(drawer.group('kolin')).toBeVisible();

  // The clean one is where this conversation works: branch, base, the Clean badge and the active marker.
  const clean = drawer.row(CLEAN_LABEL);
  await expect(clean).toContainText('atlas');
  await expect(clean).toContainText('sbx/payment-refactor');
  await expect(clean).toContainText('main');
  await expect(clean).toContainText(SANDBOX_TEXT.clean);
  await expect(clean).toContainText(SANDBOX_TEXT.activeHere);
  await expect(clean).toHaveAttribute('aria-current', 'true');
  // Its own switch button is the one control that has nothing left to do.
  await expect(drawer.useButton(CLEAN_LABEL)).toBeDisabled();

  // The dirty one states what is in it, down to the ahead/behind counts.
  const dirty = drawer.row(DIRTY_LABEL);
  await expect(dirty).toContainText('kolin');
  await expect(dirty).toContainText('sbx/catalog-spike');
  await expect(dirty).toContainText('develop');
  await expect(dirty).toContainText('Modified files: 3');
  await expect(dirty).toContainText('Untracked files: 2');
  await expect(dirty).toContainText('Ahead: 2');
  await expect(dirty).toContainText('Behind: 1');
  await expect(dirty).not.toHaveAttribute('aria-current', 'true');
  await expect(dirty).not.toContainText(SANDBOX_TEXT.clean);
});

test('switching the conversation posts workspaces/use and moves the active marker', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);
  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();

  await drawer.useButton(DIRTY_LABEL).click();

  // The upstream write carries the workspace pressed AND the conversation the chat is bound to — the
  // daemon derives the working directory from that pair, so both ids matter.
  await expect.poll(async () => (await drawer.calls()).filter((call) => call.kind === 'use'))
    .toEqual([expect.objectContaining({ kind: 'use', workspaceId: DIRTY_WORKSPACE_ID, sessionId: DEFAULT_SESSION_ID })]);

  // The marker follows the binding: a conversation works in exactly one worktree.
  await expect(drawer.row(DIRTY_LABEL)).toHaveAttribute('aria-current', 'true');
  await expect(drawer.row(DIRTY_LABEL)).toContainText(SANDBOX_TEXT.activeHere);
  await expect(drawer.row(CLEAN_LABEL)).not.toHaveAttribute('aria-current', 'true');
  await expect(drawer.row(CLEAN_LABEL)).not.toContainText(SANDBOX_TEXT.activeHere);
  await expect(drawer.useButton(DIRTY_LABEL)).toBeDisabled();
  await expect(drawer.useButton(CLEAN_LABEL)).toBeEnabled();
});

test('a removal refused with workspace_not_clean is reported and the row survives', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);
  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();

  // Removal is asked for behind the row's ⋯ menu, and the question states what would be taken with it.
  await drawer.startRemoval(DIRTY_LABEL);
  await expect(drawer.confirm).toBeVisible();
  await expect(drawer.confirm).toContainText(DIRTY_LABEL);
  await expect(drawer.confirm).toContainText('Modified files: 3');
  await expect(drawer.confirm).toContainText('Untracked files: 2');

  await drawer.confirm.getByRole('button', { name: SANDBOX_TEXT.remove }).click();

  // The daemon refuses the SAFE removal of an unclean tree, and the reason stays in the open question.
  await expect(drawer.confirm.getByRole('alert')).toHaveText(SANDBOX_TEXT.blockedNotClean);
  await expect(drawer.confirm).toBeVisible();

  // Nothing was removed, and the drawer never retries with a discarding variant.
  const calls = await drawer.calls();
  expect(calls.filter((call) => call.kind === 'remove-preview'))
    .toEqual([expect.objectContaining({ workspaceId: DIRTY_WORKSPACE_ID })]);
  expect(calls.filter((call) => call.kind === 'remove'))
    .toEqual([expect.objectContaining({ workspaceId: DIRTY_WORKSPACE_ID })]);

  await drawer.confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(drawer.confirm).toBeHidden();
  await expect(drawer.row(DIRTY_LABEL)).toBeVisible();
  await expect(drawer.rows()).toHaveCount(2);
});

test('creating a workspace posts the project, the name and the base reference', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);
  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();

  await drawer.createButton().click();
  // The project defaults to the overview's first one and the base reference to THAT project's own default
  // branch, as the overview states it; only the name is the reader's to supply.
  await drawer.root.getByLabel(SANDBOX_TEXT.label).fill('release audit');
  await expect(drawer.root.getByLabel(SANDBOX_TEXT.baseRef)).toHaveValue('main');
  // The form states that creating leaves this conversation where it is — the switch is its own step.
  await expect(drawer.root).toContainText(SANDBOX_TEXT.createHint);
  await drawer.createSubmit().click();

  await expect.poll(async () => (await drawer.calls()).filter((call) => call.kind === 'create'))
    .toEqual([expect.objectContaining({ kind: 'create', projectId: 1, label: 'release audit', baseRef: 'main' })]);

  // Creating binds nothing: the conversation still works in the workspace it was in, and no `use` write
  // went out behind the reader's back.
  expect((await drawer.calls()).filter((call) => call.kind === 'use')).toEqual([]);
  await expect(drawer.row(CLEAN_LABEL)).toHaveAttribute('aria-current', 'true');
  await expect(drawer.row('release audit')).not.toHaveAttribute('aria-current', 'true');

  // The list is re-read from the daemon rather than patched locally, so the new worktree appears in it.
  await expect(drawer.row('release audit')).toBeVisible();
  await expect(drawer.rows()).toHaveCount(3);
});

test('a project that states no default branch leaves the base reference empty', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);
  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();

  await drawer.createButton().click();
  await drawer.selectProject('kolin');

  // No guessed `main`: the field is empty, it says why, and create stays shut until a ref is supplied.
  await expect(drawer.root.getByLabel(SANDBOX_TEXT.baseRef)).toHaveValue('');
  await expect(drawer.root).toContainText(SANDBOX_TEXT.baseRefUnknown);
  await drawer.root.getByLabel(SANDBOX_TEXT.label).fill('catalog audit');
  await expect(drawer.createSubmit()).toBeDisabled();

  await drawer.root.getByLabel(SANDBOX_TEXT.baseRef).fill('trunk');
  await drawer.createSubmit().click();
  await expect.poll(async () => (await drawer.calls()).filter((call) => call.kind === 'create'))
    .toEqual([expect.objectContaining({ kind: 'create', projectId: 2, label: 'catalog audit', baseRef: 'trunk' })]);
});

test('the drawer takes focus, Tab stays inside it and Escape closes it', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);
  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();
  await expect(drawer.rows()).toHaveCount(2);

  // On open the app anchors focus on the surface itself (Modal.tsx declines Radix's first-control
  // default), so a screen reader starts at the dialog rather than mid-list.
  await expect(drawer.root).toBeFocused();

  // Tab walks the drawer's own controls and never leaves it — more presses than there are controls, so
  // the trap has to LOOP for this to hold rather than merely run out of them.
  const inside: boolean[] = [];
  const names: string[] = [];
  for (let step = 0; step < 14; step += 1) {
    await app.keyboard.press('Tab');
    const state = await app.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const surface = active?.closest('[data-slot="dialog-content"]') as HTMLElement | null;
      return {
        inside: !!surface,
        name: active?.getAttribute('aria-label') ?? active?.textContent?.trim().slice(0, 40) ?? '',
      };
    });
    inside.push(state.inside);
    names.push(state.name);
  }
  expect(inside, `focus left the drawer while tabbing; visited: ${names.join(' | ')}`).toEqual(Array(14).fill(true));
  // The walk is a real one: it reaches more than one distinct control.
  expect(new Set(names).size).toBeGreaterThan(1);

  await app.keyboard.press('Escape');
  await expect(drawer.root).toBeHidden();
  // Focus returns to the chat the command was typed in, not to nothing.
  await expect(chat.composer).toBeFocused();
});

test('at 390x844 the drawer takes the whole screen and still states every workspace', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await app.setViewportSize({ width: 390, height: 844 });
  const chat = await chatWithSandbox(app, seed);
  const drawer = new SandboxDrawer(app);

  await runSandboxCommand(chat);
  await expect(drawer.root).toBeVisible();

  // The house rule (overlayDepth.tsx) answers `fullscreen` on a phone, whatever the intent — a drawer
  // that left a strip of backdrop on a 390px screen would be a broken layout, not a layer.
  expect(await drawer.presentation()).toBe('fullscreen');
  // Polled, not sampled once: the surface animates in, so a single read can land mid-transform and
  // measure a sub-pixel offset the settled overlay does not have. What is asserted is where it COMES TO
  // REST — the whole viewport, edge to edge, with no strip of backdrop anywhere.
  await expect.poll(async () => {
    const box = await drawer.surface().boundingBox();
    return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
  }, { message: 'the fullscreen overlay never settled on the whole viewport' })
    .toEqual({ x: 0, y: 0, width: 390, height: 844 });

  // The same content, on the same open-and-render path.
  await expect(drawer.rows()).toHaveCount(2);
  await expect(drawer.row(CLEAN_LABEL)).toContainText(SANDBOX_TEXT.activeHere);
  await expect(drawer.row(CLEAN_LABEL)).toHaveAttribute('aria-current', 'true');
  await expect(drawer.row(DIRTY_LABEL)).toContainText('Modified files: 3');
  // The switch still works at this width, which is what the marker moving proves.
  await drawer.useButton(DIRTY_LABEL).click();
  await expect(drawer.row(DIRTY_LABEL)).toHaveAttribute('aria-current', 'true');
});

test('with the sandbox plugin absent from the catalog, /sandbox opens nothing', async ({ app, seed, request }, testInfo) => {
  authedOnly(testInfo);
  // The stock catalog — exactly what the daemon publishes while the plugin is switched off.
  await seed.brainCommands([...Seed.defaults.brainCommands]);
  await seed.messages([]);
  const chat = new ChatPage(app);
  await chat.goto();
  const drawer = new SandboxDrawer(app);

  await runSandboxCommand(chat);

  // The keystroke WAS processed: an unpublished slash is ordinary prose and goes upstream as a turn.
  // Asserting that first is what makes the negative below a result rather than a race with the render.
  await expect.poll(async () => {
    const res = await request.get(`${DAEMON_URL}/__test/sent`);
    const body = (await res.json()) as { sent: { text: string }[] };
    return body.sent.map((turn) => turn.text);
  }).toEqual(['/sandbox']);

  await expect(drawer.root).toBeHidden();
  expect(await app.locator('[data-testid="sandbox-workspace-row"]').count()).toBe(0);
  // And the overview was never requested, because no chooser was ever opened.
  expect(await drawer.calls()).toEqual([]);
});
