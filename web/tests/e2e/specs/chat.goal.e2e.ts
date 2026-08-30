import { test, expect, ChatPage } from '../fixtures/index.ts';

const goalCommand = {
  name: 'goal',
  description: 'Create, inspect, pause, resume or clear a persistent goal',
  kind: 'action' as const,
  execution: 'session-control' as const,
  argument: { kind: 'text' as const },
};

test('typed /goal uses the command route and stays visible across desktop and phone layouts', async ({ app, seed, calls }) => {
  await seed.brainCommands([goalCommand]);
  await app.emulateMedia({ colorScheme: 'light' });
  await app.setViewportSize({ width: 1440, height: 900 });
  const chat = new ChatPage(app);
  await chat.goto();

  await chat.sendMessage('/goal Verify desktop parity');
  await expect(app.getByTestId('telemetry-goal')).toContainText('Verify desktop parity');
  await expect.poll(async () => (await calls.commands()).map(({ name, argument, session }) => ({ name, argument, session })))
    .toEqual([{ name: 'goal', argument: 'Verify desktop parity', session: 'brain-1' }]);

  await chat.sendMessage('/goal clear');
  await expect(app.getByTestId('telemetry-goal')).toHaveCount(0);

  await app.emulateMedia({ colorScheme: 'dark' });
  await app.setViewportSize({ width: 390, height: 844 });
  await chat.sendMessage('/goal Verify phone parity');
  const compact = chat.root.getByTestId('chat-goal-status');
  await expect(compact).toContainText('Verify phone parity');
  const box = await compact.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await expect(chat.root.getByTestId('chat-composer')).toBeVisible();
});
