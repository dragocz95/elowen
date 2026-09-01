import { test, expect } from '../fixtures/index.ts';

const authedOnly = (testInfo: { project: { name: string } }) =>
  test.skip(testInfo.project.name !== 'authed', 'needs the authenticated memory workspace');

const memories = Array.from({ length: 450 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  body: `Durable memory ${index + 1}`,
  kind: index % 3 === 0 ? 'decision' : 'fact',
  importance: 1 + (index % 5),
  confidence: 0.9,
  source: 'user',
  status: 'active',
  category_id: (index % 6) + 1,
  created_at: '2026-09-01 08:00:00',
  updated_at: '2026-09-01 08:00:00',
  last_used_at: null,
  use_count: 0,
  vitality: 80,
}));

const categories = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  user_id: 1,
  name: `Category ${index + 1}`,
  description: `Memory cluster ${index + 1}`,
  color: ['#45ffb0', '#4ca6ff', '#ff6f91', '#ffc857', '#9d7cff', '#55d6be'][index],
  icon: 'Folder',
  is_builtin: 0,
  created_at: '2026-09-01 08:00:00',
}));

test('the brain renders every memory on a scrollable, readable canvas', async ({ app, seed }, testInfo) => {
  authedOnly(testInfo);
  test.setTimeout(120_000);
  await seed.response('memory', memories);
  await seed.response('memory/categories', categories);
  await app.setViewportSize({ width: 1440, height: 900 });
  await app.goto('/memory');
  await app.getByRole('radio', { name: 'Brain' }).click();

  const leaves = app.locator('[data-testid="memory-leaf-node"]');
  await expect(leaves).toHaveCount(450);
  await expect(app.getByText(/not shown/i)).toHaveCount(0);

  const viewport = app.locator('.brain-viewport');
  const geometry = await viewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
  }));
  expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  expect(geometry.scrollHeight).toBeGreaterThanOrEqual(geometry.clientHeight);

  await leaves.first().click();
  await expect(app.locator('[data-testid="memory-node-label"]')).toContainText('Durable memory 1');
  expect(Number(await leaves.nth(1).getAttribute('fill-opacity'))).toBeGreaterThanOrEqual(0.4);

  await app.setViewportSize({ width: 390, height: 844 });
  const bodyFits = await app.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(bodyFits).toBe(true);
  await expect(viewport).toBeVisible();
});
