import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';

/** The iOS keyboard path, modelled deterministically.
 *
 * Keep the rendered surface border box, innerHeight and visual viewport independent: WebKit need not
 * update them together or deliver the final visual event. These are deterministic counterexamples,
 * not a recording of hardware events. The overlap is published once to the surface while the composer
 * stays in flow. CSS ownership is pinned in `tests/styles/chatComposerDock.test.ts`; Playwright checks
 * real rects, but final device behaviour still needs an iPhone. */

class FakeVisualViewport extends EventTarget {
  width: number;
  height: number;
  offsetTop = 0;
  constructor(width: number, height: number) { super(); this.width = width; this.height = height; }
  /** Move the visual viewport the way iOS does, then deliver the event the browser would. */
  set(next: { width?: number; height?: number; offsetTop?: number }, event: 'resize' | 'scroll' = 'resize'): void {
    if (next.width !== undefined) this.width = next.width;
    if (next.height !== undefined) this.height = next.height;
    if (next.offsetTop !== undefined) this.offsetTop = next.offsetTop;
    this.dispatchEvent(new Event(event));
  }
}

class FakeES {
  static instances: FakeES[] = [];
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener() {}
  close() {}
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-09-14', running: false, active: true }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', is_admin: false } })),
  http.get('*/api/brain/conversation-links', () => HttpResponse.json({ status: 'available', links: [] })),
);

const PHONE = { width: 390, height: 844 };
const KEYBOARD_HEIGHT = 336;

let viewport: FakeVisualViewport;
let originalViewport: VisualViewport | undefined;
let originalInnerHeight: number;
let originalInnerWidth: number;
let surfaceBottom: number;
const observed = new Map<Element, ResizeObserverCallback>();

// JSDOM has no layout. Model the border box, independently of innerHeight and the visible band.
function resizeSurface(bottom: number): void {
  surfaceBottom = bottom;
  const surface = screen.getByTestId('chat-composer-dock').closest<HTMLElement>('[data-variant="full"]')!;
  observed.get(surface)?.([], {} as ResizeObserver);
}

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  originalViewport = window.visualViewport ?? undefined;
  originalInnerHeight = window.innerHeight;
  originalInnerWidth = window.innerWidth;
  surfaceBottom = PHONE.height;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.variant === 'full') {
      const height = surfaceBottom;
      return { top: 0, bottom: height, height, width: window.innerWidth, left: 0, right: window.innerWidth, x: 0, y: 0, toJSON() {} };
    }
    return originalRect.call(this);
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(element: Element) { observed.set(element, this.callback); }
    unobserve(element: Element) { observed.delete(element); }
    disconnect() {
      for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element);
    }
  });
  viewport = new FakeVisualViewport(PHONE.width, PHONE.height);
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: PHONE.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: PHONE.width });
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observed.clear();
  document.documentElement.style.removeProperty('--ui-scale');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalViewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: originalInnerHeight });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalInnerWidth });
});

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>{node}</TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

/** What the fixed chat surface is told: the visible-band inset and keyboard state. */
function published(): { inset: number; open: string | undefined } {
  const surface = screen.getByTestId('chat-composer-dock').closest<HTMLElement>('[data-variant="full"]')!;
  return {
    inset: parseFloat(surface.style.getPropertyValue('--chat-visual-bottom-offset')) || 0,
    open: surface.dataset.chatKeyboardOpen,
  };
}

/** The gap the keyboard actually leaves: from the bottom of the layout viewport (where the dock rests
 *  with no inset) up to the bottom of the visible band. This is the ONE figure the layout may consume. */
const expectedInset = () => window.innerHeight - viewport.offsetTop - viewport.height;

const settle = async () => {
  await waitFor(() => expect(published().open).toBe('false'));
};

describe('iOS soft keyboard geometry on /chat', () => {
  it('uses the rendered surface edge when innerHeight disagrees with dvh', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer');
    await settle();
    composer.focus();
    // Safari can change innerHeight independently of the CSS dvh shell. The keyboard is NOT the
    // distance to that unrelated edge. Subtracting it would lift the composer a second keyboard.
    window.innerHeight = PHONE.height + KEYBOARD_HEIGHT;
    viewport.set({ height: PHONE.height - KEYBOARD_HEIGHT, offsetTop: 60 });
    await waitFor(() => expect(published().open).toBe('true'));
    expect(published().inset).toBe(KEYBOARD_HEIGHT - 60);
  });

  it('reconciles layout return without a visual resize or scroll, even while focus is retained', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer');
    await settle();
    composer.focus();
    viewport.set({ height: 508 });
    await waitFor(() => expect(published().inset).toBe(336));

    // A later layout pass consumes part of the occlusion. No VisualViewport event accompanies it.
    resizeSurface(700);
    await waitFor(() => expect(published().inset).toBe(192));

    // Dismissal can retain focus and omit the final visual events. The CSS box returning is observable.
    viewport.height = PHONE.height;
    viewport.offsetTop = 0;
    resizeSurface(PHONE.height);
    await waitFor(() => expect(published()).toEqual({ inset: 0, open: 'false' }));
    expect(document.activeElement).toBe(composer);
  });

  it('clears on blur before delayed viewport events and does not learn a keyboard-sized baseline', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer');
    await settle();
    composer.focus();
    viewport.set({ height: 508, offsetTop: 80 });
    await waitFor(() => expect(published().inset).toBe(256));
    composer.blur();
    await settle();
    expect(published().inset).toBe(0);
    // SwiftKey's final resize may arrive with the old metrics, after blur.
    viewport.dispatchEvent(new Event('resize'));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    viewport.height = PHONE.height; // No final resize.
    viewport.offsetTop = 0;
    composer.focus();
    viewport.set({ height: 508 });
    await waitFor(() => expect(published()).toEqual({ inset: 336, open: 'true' }));
  });

  it('reads offsetTop on window scroll and converts the overlap to CSS pixels once', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer');
    await settle();
    document.documentElement.style.setProperty('--ui-scale', '1.25');
    composer.focus();
    viewport.set({ height: 508 });
    await waitFor(() => expect(published().inset).toBe(269));
    viewport.offsetTop = 100;
    window.dispatchEvent(new Event('scroll'));
    await waitFor(() => expect(published().inset).toBe(189));
  });

  it.each(['pageshow', 'visibilitychange'])('reconciles a silent viewport restoration on %s', async (event) => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer');
    await settle();
    composer.focus();
    viewport.set({ height: 508 });
    await waitFor(() => expect(published().inset).toBe(336));
    viewport.height = PHONE.height;
    (event === 'pageshow' ? window : document).dispatchEvent(new Event(event));
    await waitFor(() => expect(published()).toEqual({ inset: 0, open: 'false' }));
  });

  it('publishes the visible-band inset once for every phase of a keyboard', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer') as HTMLTextAreaElement;
    await settle();

    // ── Before the keyboard ────────────────────────────────────────────────────────────────────────
    expect(published().open).toBe('false');
    expect(published().inset).toBe(0);

    composer.focus();

    // ── Mid-animation: iOS reports the keyboard growing over several frames ─────────────────────────
    for (const height of [PHONE.height - 90, PHONE.height - 210, PHONE.height - KEYBOARD_HEIGHT]) {
      viewport.set({ height });
      await waitFor(() => expect(published().inset).toBe(expectedInset()));
      expect(published().open).toBe('true');
      // Never a multiple of it: the published figure is the distance to the visible band, and it must
      // stay inside the keyboard that caused it however far the animation has come.
      expect(published().inset).toBeLessThanOrEqual(KEYBOARD_HEIGHT);
    }

    // ── Settled ────────────────────────────────────────────────────────────────────────────────────
    expect(published().inset).toBe(KEYBOARD_HEIGHT);

    // ── iOS scrolls the visual viewport to keep the caret visible ──────────────────────────────────
    // The layout viewport does not move, so the inset SHRINKS by exactly the scroll offset. A second
    // consumer of the same figure would drive the composer up by twice this, which is the reported bug.
    viewport.set({ offsetTop: 120 }, 'scroll');
    await waitFor(() => expect(published().inset).toBe(expectedInset()));
    expect(published().inset).toBe(PHONE.height - 120 - (PHONE.height - KEYBOARD_HEIGHT));

    // ── Closing restores the resting geometry with no residue ──────────────────────────────────────
    composer.blur();
    viewport.set({ height: PHONE.height, offsetTop: 0 });
    await waitFor(() => expect(published().open).toBe('false'));
    expect(published().inset).toBe(0);
  });

  it('treats an unfocused viewport change as the new resting height, not a keyboard', async () => {
    renderChat(<main><ChatView /></main>);
    await screen.findByTestId('chat-composer');
    await settle();

    // Rotation / split screen with nothing focused: the smaller viewport IS the screen now.
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 844 });
    surfaceBottom = 390;
    viewport.set({ width: 844, height: 390 });
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect(published().open).toBe('false'));
    expect(published().inset).toBe(0);

    // Only a shrink under focus is a keyboard.
    const composer = screen.getByTestId('chat-composer') as HTMLTextAreaElement;
    composer.focus();
    viewport.set({ height: 240 });
    await waitFor(() => expect(published().open).toBe('true'));
    expect(published().inset).toBe(expectedInset());
    expect(published().inset).toBe(150);
  });

  it('keeps one inset across a rotation with the keyboard still up', async () => {
    renderChat(<main><ChatView /></main>);
    const composer = await screen.findByTestId('chat-composer') as HTMLTextAreaElement;
    await settle();

    composer.focus();
    viewport.set({ height: PHONE.height - KEYBOARD_HEIGHT });
    await waitFor(() => expect(published().open).toBe('true'));

    // Portrait → landscape while the field keeps focus: the axes exchange and the keyboard stays up.
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: PHONE.width });
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: PHONE.height });
    surfaceBottom = PHONE.width;
    viewport.set({ width: PHONE.height, height: 220 });
    await waitFor(() => expect(published().inset).toBe(expectedInset()));
    expect(published().open).toBe('true');
    expect(published().inset).toBe(PHONE.width - 220);
  });
});
