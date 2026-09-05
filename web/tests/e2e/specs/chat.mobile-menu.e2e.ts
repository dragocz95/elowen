import { test, expect, ChatPage } from '../fixtures/index.ts';

for (const width of [320, 390, 430]) {
  test(`mobile top bar provides direct reasoning and telemetry at ${width}px`, async ({ app, seed }, testInfo) => {
    await app.setViewportSize({ width, height: 844 });
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await seed.config({ allowedSkins: ['studio-light', 'studio-oled'] });
    await seed.brainStatus({ thinkingLevel: 'medium', thinkingLevels: ['low', 'medium', 'high'] });
    const chat = new ChatPage(app);
    await app.goto('/chat');
    await chat.waitForReady();
    const header = app.getByTestId('future-page-header');
    const host = app.getByTestId('page-top-bar-host');
    const trigger = host.getByRole('button', { name: 'More options', exact: true });
    const telemetry = host.getByRole('button', { name: 'Show telemetry', exact: true });
    const thoughts = host.getByRole('button', { name: 'Reasoning', exact: true });
    for (const control of [trigger, telemetry, thoughts, header.locator('.top-bar__menu'),
      header.locator('.skin-switcher__button'), header.getByRole('button', { name: /^Language:/ }),
      header.locator('.top-bar__identity'), host.getByTestId('chat-conversation-switcher')]) {
      await expect(control).toBeVisible();
    }
    expect(await app.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const boxes = await header.locator('button:visible, a:visible').evaluateAll((controls) => controls.map((control) => {
      const rect = control.getBoundingClientRect();
      return { label: control.getAttribute('aria-label') ?? control.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width };
    }));
    for (const box of boxes) {
      expect(box.x, String(box.label)).toBeGreaterThanOrEqual(0);
      expect(box.right, String(box.label)).toBeLessThanOrEqual(width);
      expect(box.width, String(box.label)).toBeGreaterThanOrEqual(24);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!; const b = boxes[j]!;
      const overlap = Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1
        && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
      expect(overlap, `${a.label} overlaps ${b.label}`).toBe(false);
    }
    await app.screenshot({ path: testInfo.outputPath('mobile-top-bar.png') });
    const popover = app.locator('[data-chat-popover]');
    await expect(popover).toHaveCount(0);
    await telemetry.click();
    await expect(app.getByRole('dialog')).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(telemetry).toBeFocused();
    await thoughts.click();
    const reasoning = app.getByRole('dialog', { name: 'Reasoning' });
    await expect(reasoning).toBeVisible();
    const applied = app.waitForResponse((response) => response.url().includes('/api/brain/think') && response.request().method() === 'POST');
    await reasoning.getByRole('slider', { name: 'Effort' }).focus();
    await app.keyboard.press('End');
    expect((await applied).ok()).toBe(true);
    await expect(reasoning.getByRole('button', { name: 'high', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await app.keyboard.press('Escape');
    await expect(thoughts).toBeFocused();
    await trigger.click();
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('button', { name: 'Show telemetry', exact: true })).toHaveCount(0);
    await expect(popover.getByRole('button', { name: 'Reasoning', exact: true })).toHaveCount(0);
    await expect(popover.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
    await expect(popover.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
    await app.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await cdp.detach();
  });
}
