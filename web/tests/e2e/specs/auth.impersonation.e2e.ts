import { test, expect } from '../fixtures/index.ts';
import { adminUser, targetUser } from '../seed/fixtures.ts';

test('impersonation switches identity across tabs without reloads or stale account UI', async ({ app, seed }) => {
  test.setTimeout(60_000);
  await seed.response('users', [adminUser, targetUser]);
  const second = await app.context().newPage();
  await Promise.all([app.goto('/dash'), second.goto('/dash')]);
  await Promise.all([
    app.getByRole('link', { name: /Users/ }).click(),
    second.getByRole('link', { name: /Users/ }).click(),
  ]);
  await expect(app.getByTestId('users-register')).toBeVisible();
  await expect(second.getByTestId('users-register')).toBeVisible();
  await app.evaluate(() => {
    const durations: number[] = [];
    (window as typeof window & { __identityLongTasks?: number[] }).__identityLongTasks = durations;
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) durations.push(entry.duration); })
      .observe({ type: 'longtask', buffered: false });
  });

  let documentRequests = 0;
  let apiRequests = 0;
  let navigations = 0;
  app.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1;
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests += 1;
  });
  app.on('framenavigated', (frame) => { if (frame === app.mainFrame()) navigations += 1; });

  await app.route('**/api/auth/impersonate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  }, { times: 1 });

  await app.getByRole('button', { name: /^target:/ }).evaluate((button: HTMLButtonElement) => button.click());
  await app.getByRole('menuitem', { name: 'Sign in as' }).click();
  await expect(app.getByLabel('Loading…')).toBeVisible();
  await expect(second.getByLabel('Loading…')).toBeVisible();

  await Promise.all([
    app.waitForURL('**/dash'),
    second.waitForURL('**/dash'),
  ]);
  await expect(app.getByRole('button', { name: 'Back to your account' })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Back to your account' })).toBeVisible();
  await expect(app.getByTestId('users-register')).toHaveCount(0);
  expect(await app.evaluate(async () => (await fetch('/api/auth/me')).json())).toEqual({ user: targetUser });
  expect(documentRequests).toBe(0);
  expect(navigations).toBeLessThanOrEqual(2);
  expect(apiRequests).toBeLessThanOrEqual(20);
  const maxLongTask = await app.evaluate(() => Math.max(0, ...((window as typeof window & { __identityLongTasks?: number[] }).__identityLongTasks ?? [])));
  expect(maxLongTask).toBeLessThan(500);

  const impersonatedCookies = await app.context().cookies();
  expect(impersonatedCookies.filter((cookie) => ['elowen_session', 'elowen_return', 'elowen_as'].includes(cookie.name))).toHaveLength(3);
  expect(impersonatedCookies.find((cookie) => cookie.name === 'elowen_session')).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(impersonatedCookies.find((cookie) => cookie.name === 'elowen_return')).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
  expect(impersonatedCookies.find((cookie) => cookie.name === 'elowen_as')).toMatchObject({ httpOnly: false, sameSite: 'Lax', path: '/' });

  await app.reload();
  await expect(app.getByRole('button', { name: 'Back to your account' })).toBeVisible();
  expect(await app.evaluate(async () => (await fetch('/api/auth/me')).json())).toEqual({ user: targetUser });

  documentRequests = 0;
  apiRequests = 0;
  navigations = 0;
  await app.getByRole('button', { name: 'Back to your account' }).click();
  await Promise.all([app.waitForURL('**/dash'), second.waitForURL('**/dash')]);
  await expect(app.getByRole('link', { name: /Users/ })).toBeVisible();
  await expect(second.getByRole('link', { name: /Users/ })).toBeVisible();
  expect(await app.evaluate(async () => (await fetch('/api/auth/me')).json())).toEqual({ user: adminUser });
  expect(documentRequests).toBe(0);
  expect(navigations).toBeLessThanOrEqual(2);
  expect(apiRequests).toBeLessThanOrEqual(20);

  await app.goBack();
  await expect(app).toHaveURL(/\/dash$/);
  expect(await app.evaluate(async () => (await fetch('/api/auth/me')).json())).toEqual({ user: adminUser });

  await app.setViewportSize({ width: 390, height: 844 });
  await app.reload();
  await expect(app.getByRole('button', { name: 'Toggle menu' })).toBeVisible();
  expect(await app.evaluate(async () => (await fetch('/api/auth/me')).json())).toEqual({ user: adminUser });
  await second.close();
});
