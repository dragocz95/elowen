import { test, expect, ChatPage } from '../fixtures/index.ts';

// Keep timing informational: shared CI CPU load is not a correctness assertion. The unit regression
// counts settled-history renders deterministically; this exercises the real mobile browser path.
test('long mobile history stays accessible during live tool updates', async ({ app, seed, sse }) => {
  test.setTimeout(90_000);
  await app.setViewportSize({ width: 390, height: 844 });
  await seed.messages(Array.from({ length: 300 }, (_, i) => ({
    id: `history-${i}`, role: 'assistant' as const, text: '',
    segments: [{ kind: 'tool' as const, name: 'Read', id: `call-${i}`, detail: `file-${i}.ts`,
      output: { title: 'result', kind: 'result' as const, text: `stored output ${i}` } }],
  })));
  const chat = new ChatPage(app);
  await chat.goto();
  for (let count = 100; count <= 300; count += 50) {
    // A prepend restores the previous first row's position, not scrollTop=0.
    await app.locator('main').hover();
    await app.mouse.wheel(0, -100_000);
    await expect(chat.turns()).toHaveCount(count);
  }
  await expect(chat.historySentinel).toHaveCount(0);
  await app.locator('main').hover();
  await app.mouse.wheel(0, 100_000);
  await sse.tool({ name: 'Bash', id: 'live-tool', detail: 'live command' });
  await sse.toolProgress('live-tool', 'progress initial');
  const live = app.locator('[data-tool-id="live-tool"]');
  await live.locator('summary').click();
  await expect(live).toContainText('progress initial');
  const cdp = await app.context().newCDPSession(app);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  const before = await metrics();
  for (let i = 0; i < 20; i++) {
    await sse.toolProgress('live-tool', `progress ${i}`);
    await expect(live).toContainText(`progress ${i}`);
  }
  const after = await metrics();
  console.info(JSON.stringify({ history: 300, updates: 20, taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
    scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
    layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000, layouts: after.LayoutCount - before.LayoutCount }));
  await cdp.detach();
  await expect(app.getByTestId('chat-tool-pill')).toHaveCount(301);
  await chat.scrollToTopForOlder();
  const oldest = app.locator('[data-tool-id="call-0"]');
  await oldest.locator('summary').click();
  await expect(oldest).toContainText('stored output 0');
  await sse.idle();
});
