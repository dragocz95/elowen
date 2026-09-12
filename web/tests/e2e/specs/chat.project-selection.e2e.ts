import { test, expect, ChatPage } from '../fixtures/index.ts';
import { DAEMON_URL } from '../fixtures/env.ts';
import type { ProjectExecutionRef } from '../../../lib/types.ts';

for (const kind of ['managed', 'host'] as const) {
  test(`new conversation retains the selected ${kind} project through send and reload`, async ({ app, seed }) => {
    await seed.messages([]);
    await seed.brainStatus({ projectRef: { kind: 'host' } });
    await seed.response('projects', [
      { id: 42, slug: 'selected-project', executionKind: kind, ...(kind === 'host' ? { path: '/host' } : {}) },
    ]);
    await app.setViewportSize({ width: 1920, height: 1080 });
    const chat = new ChatPage(app);
    await chat.goto();
    await app.getByRole('button', { name: 'New chat', exact: true }).click();
    const choice = app.getByTestId('new-conversation-projects');
    await expect(choice).toBeVisible();
    const selected = choice.getByRole('radio', { name: /selected-project/ });
    await selected.focus();
    await selected.press('Enter');
    await expect(choice).toHaveCount(0);
    const picker = app.getByTestId('chat-project-picker');
    await expect(picker).toContainText('selected-project');
    await picker.getByRole('button').click();
    await expect(app.getByRole('menuitemradio', { name: 'selected-project' })).toHaveAttribute('aria-checked', 'true');
    await app.keyboard.press('Escape');
    const accepted = app.waitForResponse((response) => response.url().endsWith('/api/brain/send') && response.request().method() === 'POST');
    await chat.sendMessage('First request in the selected project');
    expect((await accepted).status()).toBe(202);
    const sent = await app.request.get(`${DAEMON_URL}/__test/sent`);
    const body = await sent.json() as { sent: { session: string; projectRef: ProjectExecutionRef }[] };
    expect(body.sent).toHaveLength(1);
    const turn = body.sent[0];
    expect(turn.session).toMatch(/^brain-fresh-/);
    expect(turn.projectRef).toEqual({ kind, projectId: 42 });
    const status = await app.request.get(`/api/brain/status?session=${turn.session}`);
    expect(status.ok()).toBe(true);
    expect((await status.json()).projectRef).toEqual({ kind, projectId: 42 });
    await app.reload();
    await expect(picker).toContainText('selected-project');
    await expect(choice).toHaveCount(0);
  });
}

test('cancelling the new conversation question keeps the default target', async ({ app, seed }) => {
  await seed.messages([]);
  await seed.brainStatus({ projectRef: { kind: 'host' } });
  const chat = new ChatPage(app);
  await chat.goto();
  await app.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(app.getByTestId('new-conversation-projects')).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(app.getByTestId('new-conversation-projects')).toHaveCount(0);
  await expect(app.getByTestId('chat-project-picker')).toContainText('No project');
  const accepted = app.waitForResponse((response) => response.url().endsWith('/api/brain/send') && response.request().method() === 'POST');
  await chat.sendMessage('First request with the default target');
  expect((await accepted).status()).toBe(202);
  const sent = await app.request.get(`${DAEMON_URL}/__test/sent`);
  expect((await sent.json()).sent[0].projectRef).toEqual({ kind: 'host' });
});
