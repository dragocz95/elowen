import { test, expect, ChatPage } from '../fixtures/index.ts';

for (const viewport of [{ width: 390, height: 844 }, { width: 740, height: 360 }]) {
  test(`top chat overflow remains reachable at ${viewport.width}x${viewport.height}`, async ({ app, seed }) => {
    await app.setViewportSize(viewport);
    await seed.brainStatus({ thinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high'] });
    const chat = new ChatPage(app);
    await chat.goto();
    const trigger = app.getByRole('button', { name: 'More options', exact: true });
    await expect(app.getByTestId('page-top-bar-host').getByRole('button', { name: 'More options', exact: true })).toBeVisible();
    await trigger.click();
    const popover = app.locator('[data-chat-popover]');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await popover.getByRole('button', { name: 'Show telemetry', exact: true }).click();
    await expect(app.getByRole('dialog')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await popover.getByTestId('chat-thoughts-toggle').click();
    const reasoning = app.getByRole('dialog', { name: 'Reasoning' });
    await expect(reasoning).toBeVisible();
    const high = reasoning.getByRole('button', { name: 'high', exact: true });
    const applied = app.waitForResponse((response) => response.url().includes('/api/brain/think') && response.request().method() === 'POST');
    await reasoning.getByRole('slider', { name: 'Effort' }).focus();
    await app.keyboard.press('End');
    expect((await applied).ok()).toBe(true);
    await expect(high).toHaveAttribute('aria-pressed', 'true');
    await app.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.focus();
    await app.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}
