import type { ReactNode } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
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
 *  iOS does not resize the layout viewport for the soft keyboard: `window.innerHeight` stays the full
 *  screen and only `visualViewport` shrinks — and it also SCROLLS, so `offsetTop` grows as Safari pushes
 *  the focused field into the smaller visible band. The distance the composer has to travel is therefore
 *  `innerHeight - offsetTop - visualViewport.height`, and that figure may be applied to the layout exactly
 *  ONCE. Applying it twice (a second CSS rule that also offsets the dock's position) is what left the
 *  composer a whole keyboard height above the keyboard on a real iPhone, with a black band between them.
 *
 *  This suite owns the JavaScript half of that contract: the one number the surface publishes. The CSS
 *  half — that exactly one rule turns it into a position — is `tests/styles/chatComposerDock.test.ts`,
 *  and the real end-to-end geometry is measured in a browser by
 *  `tests/e2e/specs/chat.mobile-keyboard.e2e.ts`. jsdom performs no layout, so a rect assertion here
 *  would be fiction. */

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
  viewport = new FakeVisualViewport(PHONE.width, PHONE.height);
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: PHONE.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: PHONE.width });
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  localStorage.clear();
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

/** What the layout is told: the published inset, and whether the surface considers the keyboard open. */
function published(): { inset: number; open: string | undefined; composerHeight: string } {
  const surface = screen.getByTestId('chat-composer-dock').closest<HTMLElement>('[data-variant="full"]')!;
  return {
    inset: parseFloat(surface.style.getPropertyValue('--chat-visual-bottom-offset')) || 0,
    open: surface.dataset.chatKeyboardOpen,
    composerHeight: surface.style.getPropertyValue('--chat-composer-height'),
  };
}

/** The gap the keyboard actually leaves: from the bottom of the layout viewport (where the dock rests
 *  with no inset) up to the bottom of the visible band. This is the ONE figure the layout may consume. */
const expectedInset = () => window.innerHeight - viewport.offsetTop - viewport.height;

const settle = async () => {
  await waitFor(() => expect(published().composerHeight).not.toBe(''));
};

describe('iOS soft keyboard geometry on /chat', () => {
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
    viewport.set({ width: PHONE.height, height: 220 });
    await waitFor(() => expect(published().inset).toBe(expectedInset()));
    expect(published().open).toBe('true');
    expect(published().inset).toBe(PHONE.width - 220);
  });
});
