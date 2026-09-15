// The iOS soft-keyboard geometry of the /chat composer, in a real browser.
//
// Resizing Chromium's layout viewport alone cannot exercise independent visual-viewport occlusion.
// A controllable VisualViewport drives both fixed-layout profiles and a lifecycle with divergent
// innerHeight, rendered shell size and visual metrics, including missing final visual events.
// The page still uses real CSS, layout and rects; the event sequences are deterministic simulations.
//
// NOT a real iPhone. Linux Chrome cannot reproduce WebKit's keyboard, its scroll-into-view or its rubber
// banding, so this proves the geometry CONTRACT (the inset is consumed exactly once, and the composer comes
// to rest on the visible band) rather than the device. A final check on hardware is still worth one minute.
import { test, expect, ChatPage, type Page } from '../fixtures/index.ts';

const SAFE_BOTTOM = 34;

interface Profile {
  name: string;
  layout: { width: number; height: number };
  keyboard: number;
  scale: number;
}

const PROFILES: Profile[] = [
  { name: 'portrait 390x844', layout: { width: 390, height: 844 }, keyboard: 336, scale: 1 },
  // A short landscape phone at a non-default UI scale: the inset is published in CSS pixels, so a page
  // zoom that is not 1 is where a doubled figure hides best.
  { name: 'landscape 740x360 at 125%', layout: { width: 740, height: 360 }, keyboard: 190, scale: 1.25 },
  // A tablet, i.e. the other side of the 48rem phone breakpoint. iPadOS runs the same WebKit keyboard
  // policy as the phone, so every rule the keyboard geometry depends on has to hold here too — the
  // breakpoint is about layout density, not about whether a soft keyboard exists.
  { name: 'tablet portrait 820x1180', layout: { width: 820, height: 1180 }, keyboard: 400, scale: 1 },
];

/** Install a controllable visual viewport without tying its updates to a layout resize. */
async function emulateIosViewport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class IosVisualViewport extends EventTarget {
      width = window.innerWidth;
      height = window.innerHeight;
      offsetTop = 0;
      offsetLeft = 0;
      pageTop = 0;
      pageLeft = 0;
      scale = 1;
    }
    const viewport = new IosVisualViewport();
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => viewport });
    // A layout-viewport change (rotation, split view) resizes the visible band with it, exactly as the
    // browser would before any keyboard is involved.
    window.addEventListener('resize', () => {
      viewport.width = window.innerWidth;
      viewport.height = window.innerHeight - (window as unknown as { __keyboard: number }).__keyboard;
      viewport.dispatchEvent(new Event('resize'));
    });
    (window as unknown as { __keyboard: number }).__keyboard = 0;
    (window as unknown as { __ios: unknown }).__ios = {
      /** Raise a keyboard of `height` CSS px over `frames` steps, as iOS animates it. */
      async open(height: number, frames = 3) {
        for (let step = 1; step <= frames; step++) {
          (window as unknown as { __keyboard: number }).__keyboard = Math.round((height * step) / frames);
          viewport.height = window.innerHeight - (window as unknown as { __keyboard: number }).__keyboard;
          viewport.dispatchEvent(new Event('resize'));
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      },
      /** Safari scrolling the visible band down to keep the caret in view. */
      scrollBand(offsetTop: number) {
        viewport.offsetTop = offsetTop;
        viewport.dispatchEvent(new Event('scroll'));
      },
      update(next: { height?: number; offsetTop?: number }) {
        Object.assign(viewport, next);
        viewport.dispatchEvent(new Event('resize'));
      },
      close(notify = true) {
        (window as unknown as { __keyboard: number }).__keyboard = 0;
        viewport.offsetTop = 0;
        viewport.height = window.innerHeight;
        viewport.width = window.innerWidth;
        if (notify) viewport.dispatchEvent(new Event('resize'));
      },
      band() {
        return { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height };
      },
    };
  });
}

/** Everything the assertions need, read from the live layout in one pass. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const ios = (window as unknown as { __ios: { band(): { top: number; bottom: number } } }).__ios;
    const band = ios.band();
    const main = document.querySelector<HTMLElement>('main')!;
    // The page's own surface. A roomy window can also carry the advisor dock, which mounts a second chat
    // on the same controller; the routed page is the one inside <main>.
    const surface = main.querySelector<HTMLElement>('[data-variant="full"]')!;
    const dock = surface.querySelector<HTMLElement>('[data-testid="chat-composer-dock"]')!;
    const composer = surface.querySelector<HTMLElement>('.chat-composer')!;
    const turns = [...surface.querySelectorAll<HTMLElement>('[data-testid="chat-turn"]')];
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
    const dockRect = dock.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const lastRect = turns[turns.length - 1]?.getBoundingClientRect() ?? null;
    return {
      bandBottom: band.bottom,
      keyboardOpen: surface.dataset.chatKeyboardOpen,
      // The published inset, in CSS px, as the surface computed it.
      inset: parseFloat(surface.style.getPropertyValue('--chat-visual-bottom-offset')) || 0,
      dockPosition: getComputedStyle(dock).position,
      // Visual px, so they compare directly with the visual-viewport band.
      dockGap: band.bottom - dockRect.bottom,
      composerGap: band.bottom - composerRect.bottom,
      composerTop: composerRect.top,
      bandTop: band.top,
      surfaceBottom: surface.getBoundingClientRect().bottom,
      surfaceScroll: surface.scrollTop,
      mainOverflow: getComputedStyle(main).overflowY,
      documentOverflow: getComputedStyle(document.documentElement).overflowY,
      lastClearance: lastRect ? composerRect.top - lastRect.bottom : null,
      slotPadding: parseFloat(getComputedStyle(composer.parentElement!).paddingBottom) * scale,
      dockSafePadding: parseFloat(getComputedStyle(dock).paddingBottom),
      surfaceInset: parseFloat(getComputedStyle(surface).paddingBottom) * scale,
      pageScroll: document.scrollingElement?.scrollTop ?? 0,
      mainScroll: main.scrollTop,
      transcriptScroll: surface.querySelector<HTMLElement>('[data-testid="chat-transcript"]')!.scrollTop,
      horizontalOverflow: main.scrollWidth - main.clientWidth,
      innerHeight: window.innerHeight,
    };
  });
}

async function insetError(page: Page, scale = 1): Promise<number> {
  const g = await geometry(page);
  return g.inset - Math.round(Math.max(0, g.surfaceBottom - g.bandBottom) / scale);
}

const seedTurns = Array.from({ length: 60 }, (_, i) => (i % 2 === 0
  ? { id: `m${i}`, role: 'user' as const, text: `Msg ${i} (you)` }
  : { id: `m${i}`, role: 'assistant' as const, text: '', segments: [{ kind: 'text' as const, text: `Msg ${i} (elowen) with enough prose to wrap onto a second line on a phone.` }] }));

const MOBILE_TASK_CARD = {
  id: 'todos',
  title: 'Tasks',
  items: Array.from({ length: 8 }, (_, i) => ({
    id: `task-${i}`,
    text: `Mobile task ${i}`,
    status: i < 2 ? 'completed' as const : 'pending' as const,
  })),
};

for (const profile of PROFILES) {
  test(`composer rests on the visual viewport with an iOS keyboard — ${profile.name}`, async ({ app, seed }) => {
    test.setTimeout(120_000);
    await emulateIosViewport(app);
    await app.addInitScript((scale) => localStorage.setItem('elowen:ui-scale', String(scale)), profile.scale);
    await app.setViewportSize(profile.layout);
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await seed.messages(seedTurns);

    // The routed page's own surface. A roomy window can also carry the advisor dock on the same
    // controller, so every locator here is scoped to <main> rather than to the first match in the document.
    const page = app.locator('main [data-variant="full"]');
    const chat = { composer: page.getByTestId('chat-composer') };
    await app.goto('/chat');
    await expect(chat.composer).toBeVisible();
    await expect(page.getByTestId('chat-turn').last()).toContainText('Msg 59 (elowen)');
    // A real iPhone contributes this; Chromium reports 0 for env(safe-area-inset-bottom).
    await app.evaluate((inset) => document.documentElement.style.setProperty('--safe-bottom', `${inset}px`), `${SAFE_BOTTOM}`);

    const closed = await geometry(app);
    expect(closed.keyboardOpen).toBe('false');
    expect(closed.inset).toBe(0);
    expect(closed.dockPosition, 'the composer must stay in normal flex flow').toBe('static');
    expect(closed.dockSafePadding).toBe(SAFE_BOTTOM);
    expect(closed.surfaceInset).toBe(0);
    expect(closed.pageScroll).toBe(0);
    expect(closed.mainScroll).toBe(0);

    // ── The keyboard comes up ──────────────────────────────────────────────────────────────────────
    await chat.composer.focus();
    await app.evaluate((height) => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(height), profile.keyboard);
    await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('true');

    const open = await geometry(app);
    // The one figure, applied once. `innerHeight` is unchanged — this is the iOS policy, not Chromium's.
    expect(open.innerHeight).toBe(profile.layout.height);
    expect(open.inset).toBeCloseTo((open.surfaceBottom - open.bandBottom) / profile.scale, 0);
    // THE regression: with the inset applied twice the dock ends a whole keyboard above the band.
    expect(open.dockGap, 'the composer dock left the visible band').toBeGreaterThanOrEqual(-1);
    expect(open.dockGap, 'a black band opened between the composer and the keyboard').toBeLessThanOrEqual(12);
    expect(open.composerGap).toBeGreaterThanOrEqual(open.slotPadding - 1);
    expect(open.composerGap).toBeLessThanOrEqual(16);
    // The visible band already ends above the home indicator: adding the safe area again is the blank band.
    expect(open.dockSafePadding).toBe(0);
    // The surface inset reduces only the transcript's content box. Page-level scroll owners stay fixed.
    expect(open.surfaceInset).toBeGreaterThan(0);
    expect(open.pageScroll).toBe(0);
    expect(open.mainScroll).toBe(0);
    expect(open.transcriptScroll).toBeGreaterThan(0);
    expect(open.lastClearance).toBeGreaterThanOrEqual(4);
    expect(open.horizontalOverflow).toBeLessThanOrEqual(0);

    // ── Safari scrolls the band to follow the caret ────────────────────────────────────────────────
    await app.evaluate(() => (window as unknown as { __ios: { scrollBand(v: number): void } }).__ios.scrollBand(60));
    await expect.poll(() => insetError(app, profile.scale)).toBe(0);
    const scrolled = await geometry(app);
    expect(scrolled.dockGap).toBeGreaterThanOrEqual(-1);
    expect(scrolled.dockGap).toBeLessThanOrEqual(12);
    await app.evaluate(() => (window as unknown as { __ios: { scrollBand(v: number): void } }).__ios.scrollBand(0));
    await expect.poll(() => insetError(app, profile.scale)).toBe(0);

    // ── Reading history with the keyboard up: only the transcript scrolls ─────────────────────────
    await page.getByTestId('chat-transcript').evaluate((transcript) => transcript.scrollTo({ top: Math.max(0, transcript.scrollHeight / 2) }));
    const scrolledUp = await geometry(app);
    expect(scrolledUp.pageScroll).toBe(0);
    expect(scrolledUp.mainScroll).toBe(0);
    expect(scrolledUp.dockGap).toBeGreaterThanOrEqual(-1);
    expect(scrolledUp.dockGap).toBeLessThanOrEqual(12);

    // ── Closing restores the resting geometry, with no jump left behind ────────────────────────────
    await app.evaluate(() => (window as unknown as { __ios: { close(): void } }).__ios.close());
    await chat.composer.blur();
    await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('false');
    const restored = await geometry(app);
    expect(restored.inset).toBe(0);
    expect(restored.surfaceInset).toBe(0);
    expect(restored.dockSafePadding).toBe(SAFE_BOTTOM);
    expect(restored.pageScroll).toBe(0);
    expect(restored.mainScroll).toBe(0);
    expect(restored.dockGap).toBeGreaterThanOrEqual(-1);
    expect(restored.dockGap).toBeLessThanOrEqual(12 + SAFE_BOTTOM);
    expect(restored.horizontalOverflow).toBeLessThanOrEqual(0);
    await cdp.detach();
  });
}

test('SwiftKey lifecycle reconciles independent layout metrics and missing visual events', async ({ app, seed }) => {
  test.setTimeout(120_000);
  await emulateIosViewport(app);
  await app.setViewportSize({ width: 390, height: 844 });
  await seed.messages(seedTurns);
  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');
  await app.evaluate(() => document.documentElement.style.setProperty('--safe-bottom', '34px'));
  await chat.composer.focus();

  await app.evaluate(() => {
    const ios = (window as unknown as { __ios: { update(next: { height: number; offsetTop: number }): void } }).__ios;
    // Deliberately decouple Safari's JS metric from CSS dvh. The old test made them identical.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1180 });
    ios.update({ height: 508, offsetTop: 60 });
  });
  await expect.poll(() => insetError(app)).toBe(0);
  const assertVisible = async () => {
    const g = await geometry(app);
    expect(g.dockGap).toBeGreaterThanOrEqual(-1);
    expect(g.dockGap).toBeLessThanOrEqual(12);
    expect(g.composerTop).toBeGreaterThanOrEqual(g.bandTop);
    expect(g.pageScroll).toBe(0);
    expect(g.mainScroll).toBe(0);
    expect(g.surfaceScroll).toBe(0);
    expect(g.mainOverflow).toBe('clip');
    expect(g.documentOverflow).toBe('clip');
    await expect(chat.composer).toBeVisible();
  };
  await assertVisible();

  // A layout resize without a VisualViewport event must not spend the consumed height a second time.
  await app.evaluate(() => { document.querySelector<HTMLElement>('.shell-viewport')!.style.height = '700px'; });
  await expect.poll(() => insetError(app)).toBe(0);
  await assertVisible();

  // Hardware Done may retain focus. Only the returning CSS layout reports the final closing geometry.
  await app.evaluate(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    (window as unknown as { __ios: { close(notify: boolean): void } }).__ios.close(false);
    document.querySelector<HTMLElement>('.shell-viewport')!.style.height = 'calc(100dvh / var(--ui-scale, 1))';
  });
  await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('false');
  expect((await geometry(app)).inset).toBe(0);
  expect((await geometry(app)).dockSafePadding).toBe(SAFE_BOTTOM);
  await expect(chat.composer).toBeFocused();
  await assertVisible();

  for (let cycle = 0; cycle < 3; cycle++) {
    await chat.composer.focus();
    await app.evaluate(() => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(336));
    await expect.poll(() => insetError(app)).toBe(0);
    await assertVisible();
    await chat.composer.fill(`Draft survives keyboard cycle ${cycle}`);
    // Blur FIRST, old metrics in a delayed resize, then restore metrics with no final visual event.
    await chat.composer.blur();
    await expect.poll(async () => (await geometry(app)).inset).toBe(0);
    await app.evaluate(() => {
      const ios = (window as unknown as { __ios: { update(next: { height: number }): void; close(notify: boolean): void } }).__ios;
      ios.update({ height: 508 });
    });
    await app.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await app.evaluate(() => (window as unknown as { __ios: { close(notify: boolean): void } }).__ios.close(false));
    await assertVisible();
    await expect(chat.composer).toHaveValue(`Draft survives keyboard cycle ${cycle}`);
  }
});

test('focusing the composer leaves page scroll fixed and moves only the transcript', async ({ app, seed }) => {
  test.setTimeout(120_000);
  await emulateIosViewport(app);
  await app.setViewportSize({ width: 390, height: 844 });
  await seed.messages(seedTurns);

  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');

  const resetAndRead = () => app.evaluate(() => {
    const page = document.scrollingElement as HTMLElement;
    const main = document.querySelector<HTMLElement>('main')!;
    const transcript = document.querySelector<HTMLElement>('[data-variant="full"] [data-testid="chat-transcript"]')!;
    page.scrollTop = 0;
    main.scrollTop = 0;
    transcript.scrollTop = 0;
    return { page: page.scrollTop, main: main.scrollTop, transcript: transcript.scrollTop };
  });
  const before = await resetAndRead();

  await chat.composer.focus();
  await app.evaluate(() => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(336));
  await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('true');

  const after = await app.evaluate(() => {
    const page = document.scrollingElement as HTMLElement;
    const main = document.querySelector<HTMLElement>('main')!;
    const transcript = document.querySelector<HTMLElement>('[data-variant="full"] [data-testid="chat-transcript"]')!;
    return { page: page.scrollTop, main: main.scrollTop, transcript: transcript.scrollTop };
  });
  expect(after.page, 'composer focus scrolled the document').toBe(before.page);
  expect(after.main, 'composer focus scrolled the shell page instead of the transcript').toBe(before.main);
  expect(after.transcript, 'the transcript did not take ownership of follow-newest scrolling').toBeGreaterThan(before.transcript);
});

test('typing with the keyboard up survives high-frequency stream updates', async ({ app, seed, sse }) => {
  test.setTimeout(120_000);
  await emulateIosViewport(app);
  await app.setViewportSize({ width: 390, height: 844 });
  const cdp = await app.context().newCDPSession(app);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await seed.messages(seedTurns);
  await seed.brainStatus({ running: true, cards: [MOBILE_TASK_CARD] });

  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');
  await chat.composer.focus();
  await app.evaluate(() => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(336));
  await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('true');

  // A live turn in the transcript, Todo pinned in the footer, a settled agent, a running tool reporting
  // progress, and the reader typing on top.
  await sse.user('A question that is being answered while the reader types the next one');
  await sse.tool({ name: 'Delegate', id: 'delegate-finished', detail: 'Finished mobile helper' });
  expect(await sse.emit({
    type: 'subagent', id: 'delegate-finished', sessionId: 'child-finished', status: 'done',
    task: 'Finished mobile helper', name: 'Finished mobile helper', tools: 3, tokens: 900, seconds: 12,
  })).toBeGreaterThan(0);
  await expect(app.getByTestId('chat-agents-open')).toBeVisible();
  await sse.tool({ name: 'Bash', id: 'live-tool', detail: 'npm test' });
  const ambientLayout = () => app.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main')!;
    const surface = main.querySelector<HTMLElement>('[data-variant="full"]')!;
    const ambient = surface.querySelector<HTMLElement>('[data-testid="chat-ambient-extras"]')!;
    const live = surface.querySelector<HTMLElement>('[data-tk^="live:"]')!;
    const transcript = surface.querySelector<HTMLElement>('[data-testid="chat-transcript"]')!;
    const todo = surface.querySelector<HTMLElement>('[data-testid="chat-footer-cards"] [data-testid="chat-card"]')!;
    const statusline = surface.querySelector<HTMLElement>('[data-testid="chat-statusline"]')!;
    const ambientRect = ambient.getBoundingClientRect();
    return {
      topInScrollContent: ambientRect.top + transcript.scrollTop,
      ambientBottom: ambientRect.bottom,
      liveTop: live.getBoundingClientRect().top,
      todoTop: todo.getBoundingClientRect().top,
      beforeLive: Boolean(ambient.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING),
      todoAfterLive: Boolean(live.compareDocumentPosition(todo) & Node.DOCUMENT_POSITION_FOLLOWING),
      todoBeforeStatusline: Boolean(todo.compareDocumentPosition(statusline) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  const ambientBefore = await ambientLayout();
  expect(ambientBefore.beforeLive, 'the agents control must precede the growing live turn').toBe(true);
  expect(ambientBefore.todoAfterLive, 'Todo appeared above the assistant reply').toBe(true);
  expect(ambientBefore.todoBeforeStatusline, 'Todo did not stay above the statusline').toBe(true);

  const typed = 'Ahoj, tohle píšu zatímco běží odpověď.';
  for (const chunk of typed.match(/.{1,6}/g) ?? []) {
    await sse.toolProgress('live-tool', `progress ${chunk}`);
    await sse.text(`${chunk} ${'live answer keeps growing '.repeat(8)}`);
    await chat.composer.pressSequentially(chunk);
  }
  await expect(chat.composer).toHaveValue(typed);

  const ambientAfter = await ambientLayout();
  expect(ambientAfter.beforeLive).toBe(true);
  expect(ambientAfter.topInScrollContent,
    'streamed text moved the unchanged agents control through the document')
    .toBeCloseTo(ambientBefore.topInScrollContent, 0);
  expect(ambientAfter.ambientBottom,
    'ambient controls still occupied the tail below the live answer')
    .toBeLessThanOrEqual(ambientAfter.liveTop);
  expect(ambientAfter.todoTop, 'streamed text moved the footer Todo card')
    .toBeCloseTo(ambientBefore.todoTop, 0);
  expect(ambientAfter.todoAfterLive).toBe(true);
  expect(ambientAfter.todoBeforeStatusline).toBe(true);

  const busy = await geometry(app);
  expect(busy.keyboardOpen).toBe('true');
  expect(busy.dockGap).toBeGreaterThanOrEqual(-1);
  expect(busy.dockGap).toBeLessThanOrEqual(12);
  expect(busy.horizontalOverflow).toBeLessThanOrEqual(0);
  // The caret is still where the reader left it, at the end of what they typed.
  expect(await chat.composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(typed.length);
  await sse.idle();
  await cdp.detach();
});
