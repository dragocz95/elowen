import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';

/** A docked plugin card (the browser monitor) floats over the transcript above the composer and takes no
 *  room in the flow, so the tail of a long conversation runs underneath it. The surface answers by wrapping
 *  the prose AROUND it — a real float in the last markdown block — and clears only whatever the wrap could
 *  not, as a small bottom reserve.
 *
 *  jsdom lays nothing out, so every rect the measurement reads is stubbed. That makes these assertions
 *  about the DECISION the hook takes from a given geometry, which is where the bugs live: the two-phase
 *  measurement, the spacer offset, and the difference-only reserve. */

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

// The last turn is assistant PROSE, which is the only thing a float can wrap.
const HISTORY = [
  { id: 'm1', role: 'user', text: 'a question' },
  { id: 'm2', role: 'assistant', text: '', segments: [{ kind: 'text', text: 'a long answer' }] },
];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: HISTORY, hasMore: false, nextBefore: null })
    : HttpResponse.json(HISTORY)),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', running: false, active: true }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** Give an element the rect the real layout would have. `width` is also what tells `lastContentRect` the
 *  element has a box at all. */
function setRect(el: Element, top: number, bottom: number, width = 800): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom, left: 0, right: width, width, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }),
  });
}

/** The prose block's rect, but only while the wrap spacer is OFF. Reading it with the spacer on returns a
 *  taller block — the float pushes lines down — and that is precisely the feedback the hook must not take.
 *  Anything measuring the wrapped block instead sees `WRAPPED_HEIGHT` and computes the wrong offset. */
function setTwoPhaseRect(el: HTMLElement, top: number, unwrappedBottom: number, wrappedBottom: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const bottom = el.getAttribute('data-chat-dock-wrap') === 'on' ? wrappedBottom : unwrappedBottom;
      return { top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
    },
  });
}

const CARD_HEIGHT = 200;
const CARD_WIDTH = 320;
const GAP = 12; // 0.75rem at the 16px root font size

/** Stand in for the plugin's card: an absolutely positioned element inside a core-rendered artifact host,
 *  whose height matches what the plugin published. That pair IS the contract the core identifies it by. */
function mountCard(transcript: HTMLElement, height = CARD_HEIGHT): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute('data-artifact-id', 'browser-1');
  const card = document.createElement('div');
  card.style.position = 'absolute';
  host.appendChild(card);
  transcript.appendChild(host);
  setRect(card, 0, height, CARD_WIDTH);
  return card;
}

async function mountChat() {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><main><ChatView /></main></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  FakeES.instances[0]!.emit('snapshot', {
    type: 'snapshot', sessionId: 'brain-1', history: HISTORY, events: [], hasMore: false, nextBefore: null,
  });
  const transcript = await screen.findByTestId('chat-transcript');
  const dock = screen.getByTestId('chat-composer-dock');
  const surface = dock.closest<HTMLElement>('[data-variant="full"]')!;
  await waitFor(() => expect(transcript.querySelectorAll('[data-tk]').length).toBeGreaterThan(0));
  const turns = transcript.querySelectorAll<HTMLElement>('[data-tk]');
  const lastTurn = turns[turns.length - 1]!;
  const prose = lastTurn.querySelector<HTMLElement>('.chat-markdown')!;
  return { transcript, dock, surface, lastTurn, prose };
}

/** The plugin publishing (or withdrawing) its card height. That inline write is the seam the core watches,
 *  so it is also how a test drives a remeasure. */
function publishCardHeight(surface: HTMLElement, height: number | null): void {
  act(() => {
    if (height === null) surface.style.removeProperty('--chat-dock-height');
    else surface.style.setProperty('--chat-dock-height', `${height}px`);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const reserveOf = (t: HTMLElement) => t.style.getPropertyValue('--chat-dock-reserve');
const spacerTopOf = (p: HTMLElement) => p.style.getPropertyValue('--chat-dock-spacer-top');

describe('the transcript wraps its last prose block around a docked plugin card', () => {
  it('offsets the spacer so it covers the card zone when the prose is taller than the card', async () => {
    const { transcript, dock, surface, prose, lastTurn } = await mountChat();
    mountCard(transcript);
    // The prose block is 300 tall and ends at 500, inside the card zone (600 - 12 - 200 = 388).
    setRect(dock, 600, 700);
    setRect(lastTurn, 180, 500);
    setRect(prose, 200, 500);

    publishCardHeight(surface, CARD_HEIGHT);

    // 300 - 200: the float starts 100px down so its box lands on the block's last 200px.
    await waitFor(() => expect(spacerTopOf(prose)).toBe('100px'));
    expect(prose.getAttribute('data-chat-dock-wrap')).toBe('on');
    expect(surface.style.getPropertyValue('--chat-dock-width')).toBe(`${CARD_WIDTH}px`);
    // The wrap cleared the whole card, so nothing is left to reserve — and no empty band appears.
    expect(reserveOf(transcript)).toBe('');
  });

  it('reserves only the DIFFERENCE when the prose block is shorter than the card', async () => {
    const { transcript, dock, surface, prose, lastTurn } = await mountChat();
    mountCard(transcript);
    // A 60px block ending at 500, still inside the zone. The float can only wrap 60px of the card.
    setRect(dock, 600, 700);
    setRect(lastTurn, 420, 500);
    setRect(prose, 440, 500);

    publishCardHeight(surface, CARD_HEIGHT);

    await waitFor(() => expect(prose.getAttribute('data-chat-dock-wrap')).toBe('on'));
    expect(spacerTopOf(prose)).toBe('0px');
    // The block wraps itself, so only what sits ABOVE it still needs clearing: the distance from the card
    // zone's top edge down to where the block starts. Never the full card height an unconditional reserve
    // would take, and never the raw overlap either, which ignores the share the wrap already carried.
    expect(reserveOf(transcript)).toBe(`${440 - (600 - GAP - CARD_HEIGHT)}px`);
  });

  it('leaves a short conversation completely alone', async () => {
    const { transcript, dock, surface, prose, lastTurn } = await mountChat();
    mountCard(transcript);
    // Ends at 300, well above the zone top of 388. This is the empty-band regression: nothing may happen.
    setRect(dock, 600, 700);
    setRect(lastTurn, 220, 300);
    setRect(prose, 240, 300);

    publishCardHeight(surface, CARD_HEIGHT);

    await waitFor(() => expect(surface.style.getPropertyValue('--chat-dock-height')).toBe('200px'));
    await settle();
    expect(prose.hasAttribute('data-chat-dock-wrap')).toBe(false);
    expect(reserveOf(transcript)).toBe('');
  });

  it('measures the block with the spacer OFF, so the float never feeds its own growth back in', async () => {
    const { transcript, dock, surface, prose, lastTurn } = await mountChat();
    mountCard(transcript);
    setRect(dock, 600, 700);
    setRect(lastTurn, 180, 500);
    // Unwrapped the block is 300 tall (ends at 500). Wrapped, the float pushes it to 420 tall (ends at
    // 620), because the text now flows beside the card. Measuring the WRAPPED height would give a spacer
    // offset of 420 - 200 = 220 and then keep chasing itself.
    setTwoPhaseRect(prose, 200, 500, 620);

    publishCardHeight(surface, CARD_HEIGHT);

    await waitFor(() => expect(spacerTopOf(prose)).toBe('100px'));
    // Drive several more measurements: the answer must not move.
    act(() => { surface.style.setProperty('--chat-composer-height', '90px'); });
    act(() => { surface.style.setProperty('--chat-composer-height', '92px'); });
    await settle();
    expect(spacerTopOf(prose)).toBe('100px');
    expect(reserveOf(transcript)).toBe('');
  });

  it('takes the wrap and the reserve back off when the card goes away', async () => {
    const { transcript, dock, surface, prose, lastTurn } = await mountChat();
    mountCard(transcript);
    setRect(dock, 600, 700);
    setRect(lastTurn, 420, 500);
    setRect(prose, 440, 500);
    publishCardHeight(surface, CARD_HEIGHT);
    await waitFor(() => expect(reserveOf(transcript)).toBe(`${440 - (600 - GAP - CARD_HEIGHT)}px`));

    // The plugin removes the variable when the card is expanded, portalled away, or on a phone.
    publishCardHeight(surface, null);

    await waitFor(() => expect(reserveOf(transcript)).toBe(''));
    expect(prose.hasAttribute('data-chat-dock-wrap')).toBe(false);
  });
});
