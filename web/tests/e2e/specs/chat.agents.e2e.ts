import type { Page } from '@playwright/test';
import { test, expect, ChatPage } from '../fixtures/index.ts';
import type { Seed } from '../fixtures/Seed.ts';
import { DAEMON_URL } from '../fixtures/env.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated chat');

const childOne = 'brain-ch-subagent-child-one';
const childTwo = 'brain-ch-subagent-child-two';

async function seedAgents(seed: Seed): Promise<void> {
  await seed.messages([
    { id: 'u1', role: 'user', text: 'Delegate the audit' },
    {
      id: 'a1', role: 'assistant', text: '', segments: [
        {
          kind: 'tool', id: 'delegate-one', name: 'Delegate', detail: 'Inspect responsive layout',
          sub: {
            sessionId: childOne, status: 'running', task: 'Inspect responsive layout', detail: 'Read AgentsTable.tsx',
            tools: 4, tokens: 1280, seconds: 20, model: 'anthropic/sonnet',
            thinkingLevel: 'high', thinkingLabel: 'High',
            startedAt: '2026-08-30 05:00:00', updatedAt: '2026-08-30 05:00:20',
            background: true, autoDeliver: true, resultDelivery: 'pending',
          },
        },
        {
          kind: 'tool', id: 'delegate-two', name: 'Delegate', detail: 'Verify keyboard access',
          sub: {
            sessionId: childTwo, status: 'done', task: 'Verify keyboard access', detail: 'Run Playwright',
            tools: 7, tokens: 2400, seconds: 42, model: 'openai/gpt-5',
            thinkingLevel: 'medium', thinkingLabel: 'Medium',
            startedAt: '2026-08-30 04:58:00', updatedAt: '2026-08-30 04:58:42',
            background: false, autoDeliver: false, resultDelivery: 'acknowledged',
          },
        },
      ],
    },
  ]);
}

async function expectChildStream(page: Page, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const response = await page.request.get(`${DAEMON_URL}/__test/streams?session=${sessionId}`);
    const body = await response.json() as { streams: unknown[] };
    return body.streams.length;
  }, { message: `read-only stream did not open for ${sessionId}` }).toBeGreaterThan(0);
  await expect(page.getByText(/read-only/i)).toBeVisible();
}

test('agents modal scrolls horizontally at 390px and opens the clicked child', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await app.setViewportSize({ width: 390, height: 844 });
  await seedAgents(seed);
  const chat = new ChatPage(app);
  await chat.goto();

  await chat.agentsButton().click();
  const dialog = chat.agentsDialog();
  await expect(dialog).toBeVisible();
  const body = dialog.locator('.overflow-y-auto.overscroll-contain');
  const table = dialog.getByTestId('agents-table');
  await expect(table).toBeVisible();

  const dimensions = await body.evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  const statusBox = await dialog.getByRole('columnheader', { name: 'Status' }).boundingBox();
  const taskBox = await dialog.getByRole('columnheader', { name: 'Task' }).boundingBox();
  expect(statusBox?.x).toBeGreaterThanOrEqual(0);
  expect(taskBox?.x).toBeLessThan(390);

  await body.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
  const late = dialog.getByRole('columnheader', { name: 'Mode / delivery' });
  await expect(late).toBeInViewport();
  await expect(dialog.getByText('Automatic delivery')).toBeVisible();

  await body.evaluate((node) => { node.scrollLeft = 0; });
  await chat.agentOpenButton('Inspect responsive layout').click();
  await expectChildStream(app, childOne);
});

test('agents row opens the correct child with native keyboard activation', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  await app.setViewportSize({ width: 390, height: 844 });
  await seedAgents(seed);
  const chat = new ChatPage(app);
  await chat.goto();

  await chat.agentsButton().click();
  const open = chat.agentOpenButton('Verify keyboard access');
  await open.focus();
  await expect(open).toBeFocused();
  await open.press('Space');
  await expectChildStream(app, childTwo);
});
