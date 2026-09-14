// The iOS soft-keyboard geometry of the /chat composer, in a real browser.
//
// Chromium's own soft keyboard resizes the LAYOUT viewport (`interactive-widget=resizes-content`), so a
// `setViewportSize` "keyboard" publishes an inset of zero and can never show what iOS does — which is why
// the double-applied inset shipped. iOS keeps the layout viewport at full height and shrinks (and scrolls)
// only `visualViewport`, so this spec installs a controllable `visualViewport` before the app boots and
// drives it the way iOS does. Everything else is the real page: real CSS, real layout, real rects.
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

/** Install an iOS-shaped `visualViewport`: the layout viewport never changes, the visible band does. */
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
      close() {
        (window as unknown as { __keyboard: number }).__keyboard = 0;
        viewport.offsetTop = 0;
        viewport.height = window.innerHeight;
        viewport.width = window.innerWidth;
        viewport.dispatchEvent(new Event('resize'));
      },
      band() {
        return { top: viewport.offsetTop, bottom: viewport.offsetTop + viewport.height, height: viewport.height };
      },
    };
  });
}

/** Everything the assertions need, read from the live layout in one pass. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const ios = (window as unknown as { __ios: { band(): { top: number; bottom: number; height: number } } }).__ios;
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
      dockBottom: dockRect.bottom,
      dockGap: band.bottom - dockRect.bottom,
      composerGap: band.bottom - composerRect.bottom,
      lastClearance: lastRect ? composerRect.top - lastRect.bottom : null,
      slotPadding: parseFloat(getComputedStyle(composer.parentElement!).paddingBottom) * scale,
      dockSafePadding: parseFloat(getComputedStyle(dock).paddingBottom),
      surfaceTail: parseFloat(getComputedStyle(surface).paddingBottom) * scale,
      horizontalOverflow: main.scrollWidth - main.clientWidth,
      innerHeight: window.innerHeight,
    };
  });
}

const seedTurns = Array.from({ length: 60 }, (_, i) => (i % 2 === 0
  ? { id: `m${i}`, role: 'user' as const, text: `Msg ${i} (you)` }
  : { id: `m${i}`, role: 'assistant' as const, text: '', segments: [{ kind: 'text' as const, text: `Msg ${i} (elowen) with enough prose to wrap onto a second line on a phone.` }] }));

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
    expect(closed.dockPosition, 'the dock must be sticky, or the inset below becomes a second offset').toBe('sticky');
    expect(closed.dockSafePadding).toBe(SAFE_BOTTOM);
    expect(closed.surfaceTail).toBe(0);

    // ── The keyboard comes up ──────────────────────────────────────────────────────────────────────
    await chat.composer.focus();
    await app.evaluate((height) => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(height), profile.keyboard);
    await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('true');

    const open = await geometry(app);
    // The one figure, applied once. `innerHeight` is unchanged — this is the iOS policy, not Chromium's.
    expect(open.innerHeight).toBe(profile.layout.height);
    expect(open.inset).toBeCloseTo(profile.keyboard / profile.scale, 0);
    // THE regression: with the inset applied twice the dock ends a whole keyboard above the band.
    expect(open.dockGap, 'the composer dock left the visible band').toBeGreaterThanOrEqual(-1);
    expect(open.dockGap, 'a black band opened between the composer and the keyboard').toBeLessThanOrEqual(12);
    expect(open.composerGap).toBeGreaterThanOrEqual(open.slotPadding - 1);
    expect(open.composerGap).toBeLessThanOrEqual(16);
    // The visible band already ends above the home indicator: adding the safe area again is the blank band.
    expect(open.dockSafePadding).toBe(0);
    // The tail is what lets the reader scroll the last turn clear of the risen dock.
    expect(open.surfaceTail).toBeGreaterThan(0);
    expect(open.lastClearance).toBeGreaterThanOrEqual(4);
    expect(open.horizontalOverflow).toBeLessThanOrEqual(0);

    // ── Safari scrolls the band to follow the caret ────────────────────────────────────────────────
    await app.evaluate(() => (window as unknown as { __ios: { scrollBand(v: number): void } }).__ios.scrollBand(60));
    await expect.poll(async () => (await geometry(app)).inset).toBeCloseTo((profile.keyboard - 60) / profile.scale, 0);
    const scrolled = await geometry(app);
    expect(scrolled.dockGap).toBeGreaterThanOrEqual(-1);
    expect(scrolled.dockGap).toBeLessThanOrEqual(12);
    await app.evaluate(() => (window as unknown as { __ios: { scrollBand(v: number): void } }).__ios.scrollBand(0));
    await expect.poll(async () => (await geometry(app)).inset).toBeCloseTo(profile.keyboard / profile.scale, 0);

    // ── Reading history with the keyboard up: the dock sticks, it does not scroll away ─────────────
    await app.locator('main').evaluate((main) => main.scrollTo({ top: Math.max(0, main.scrollHeight / 2) }));
    const scrolledUp = await geometry(app);
    expect(scrolledUp.dockGap).toBeGreaterThanOrEqual(-1);
    expect(scrolledUp.dockGap).toBeLessThanOrEqual(12);

    // ── Closing restores the resting geometry, with no jump left behind ────────────────────────────
    await app.evaluate(() => (window as unknown as { __ios: { close(): void } }).__ios.close());
    await chat.composer.blur();
    await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('false');
    const restored = await geometry(app);
    expect(restored.inset).toBe(0);
    expect(restored.surfaceTail).toBe(0);
    expect(restored.dockSafePadding).toBe(SAFE_BOTTOM);
    expect(restored.dockGap).toBeGreaterThanOrEqual(-1);
    expect(restored.dockGap).toBeLessThanOrEqual(12 + SAFE_BOTTOM);
    expect(restored.horizontalOverflow).toBeLessThanOrEqual(0);
    await cdp.detach();
  });
}

test('typing with the keyboard up survives high-frequency stream updates', async ({ app, seed, sse }) => {
  test.setTimeout(120_000);
  await emulateIosViewport(app);
  await app.setViewportSize({ width: 390, height: 844 });
  const cdp = await app.context().newCDPSession(app);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await seed.messages(seedTurns);

  const chat = new ChatPage(app);
  await chat.goto();
  await expect(chat.lastTurn()).toContainText('Msg 59 (elowen)');
  await chat.composer.focus();
  await app.evaluate(() => (window as unknown as { __ios: { open(h: number): Promise<void> } }).__ios.open(336));
  await expect.poll(async () => (await geometry(app)).keyboardOpen).toBe('true');

  // A live turn underneath, a running tool reporting progress, and the reader typing on top of it.
  await sse.user('A question that is being answered while the reader types the next one');
  await sse.tool({ name: 'Bash', id: 'live-tool', detail: 'npm test' });
  const typed = 'Ahoj, tohle píšu zatímco běží odpověď.';
  for (const chunk of typed.match(/.{1,6}/g) ?? []) {
    await sse.toolProgress('live-tool', `progress ${chunk}`);
    await sse.text(`${chunk} `);
    await chat.composer.pressSequentially(chunk);
  }
  await expect(chat.composer).toHaveValue(typed);

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
