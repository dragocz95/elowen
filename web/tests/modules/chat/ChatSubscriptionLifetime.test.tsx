import { StrictMode, useState, type ReactNode } from 'react';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider, useBrainChat, type BrainChatActions } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';

/** Every live thing the chat surface attaches to the outside world has to come back off again.
 *
 *  The chat keeps several: a visual-viewport listener pair that owns the keyboard geometry, observers that
 *  re-measure the composer dock and the transcript, scroll/touch/key listeners on the page scroller, and
 *  the stream itself. A second live copy of any of them is invisible in the UI and expensive in exactly
 *  the situation this branch is about: every copy does the same measurement, the same forced layout and
 *  the same scroll write, on a phone, while a turn streams.
 *
 *  Four ways a duplicate is normally created, all covered below: React's StrictMode double-invoke, leaving
 *  /chat and coming back, the tab going to the background and returning, and switching conversation. */

class FakeES {
  static instances: FakeES[] = [];
  static get open(): FakeES[] { return FakeES.instances.filter((stream) => !stream.closed); }
  closed = false;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

/** A counting stand-in for an observer class: how many are constructed, and how many are still live. */
function countingObserver(): { live: () => number; created: () => number; ctor: typeof ResizeObserver } {
  let created = 0;
  let live = 0;
  class Counting {
    constructor(_callback: unknown) { created += 1; live += 1; }
    observe() {}
    unobserve() {}
    disconnect() { live -= 1; }
    takeRecords() { return []; }
  }
  return { live: () => live, created: () => created, ctor: Counting as unknown as typeof ResizeObserver };
}

/** Net listener count per event type on one target. */
function listenerLedger(target: EventTarget): { net: () => Record<string, number>; restore: () => void } {
  const counts: Record<string, number> = {};
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type: string, ...rest: unknown[]) => {
    counts[type] = (counts[type] ?? 0) + 1;
    return add(type, ...(rest as [EventListenerOrEventListenerObject]));
  };
  target.removeEventListener = (type: string, ...rest: unknown[]) => {
    counts[type] = (counts[type] ?? 0) - 1;
    return remove(type, ...(rest as [EventListenerOrEventListenerObject]));
  };
  return {
    net: () => Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== 0)),
    restore: () => { target.addEventListener = add; target.removeEventListener = remove; },
  };
}

class FakeVisualViewport extends EventTarget {
  width = 390;
  height = 844;
  offsetTop = 0;
}

/** Every send and abort the surface makes, so an action captured at mount can be checked against what it
 *  actually asked the daemon to do. */
const sends: { text: string; session?: string; mode?: string }[] = [];
const aborts: (string | undefined)[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', async ({ request }) => {
    sends.push(await request.json() as { text: string; session?: string; mode?: string });
    return HttpResponse.json({ ok: true }, { status: 202 });
  }),
  http.post('*/api/brain/abort', async ({ request }) => {
    aborts.push((await request.json() as { session?: string }).session);
    return HttpResponse.json({ ok: true });
  }),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([
    { id: 'brain-1', title: 'First', model: 'm', updated_at: '2026-09-14', running: false, active: true },
    { id: 'brain-2', title: 'Second', model: 'm', updated_at: '2026-09-13', running: false, active: false },
  ])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', is_admin: false } })),
  http.get('*/api/brain/conversation-links', () => HttpResponse.json({ status: 'available', links: [] })),
);

let viewport: FakeVisualViewport;
let originalViewport: VisualViewport | undefined;
let resizeObservers: ReturnType<typeof countingObserver>;
let mutationObservers: ReturnType<typeof countingObserver>;
let originalResizeObserver: typeof ResizeObserver;
let originalMutationObserver: typeof MutationObserver;
let windowListeners: ReturnType<typeof listenerLedger>;
let viewportListeners: ReturnType<typeof listenerLedger>;

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterAll(() => server.close());
beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
  originalViewport = window.visualViewport ?? undefined;
  viewport = new FakeVisualViewport();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  originalResizeObserver = globalThis.ResizeObserver;
  originalMutationObserver = globalThis.MutationObserver;
  resizeObservers = countingObserver();
  mutationObservers = countingObserver();
  globalThis.ResizeObserver = resizeObservers.ctor;
  globalThis.MutationObserver = mutationObservers.ctor as unknown as typeof MutationObserver;
  windowListeners = listenerLedger(window);
  viewportListeners = listenerLedger(viewport);
});
afterEach(() => {
  windowListeners.restore();
  viewportListeners.restore();
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.MutationObserver = originalMutationObserver;
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: originalViewport });
  server.resetHandlers();
  FakeES.instances.length = 0;
  sends.length = 0;
  aborts.length = 0;
  localStorage.clear();
});

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>{node}</TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

/** Everything that must be single. */
const live = () => ({
  streams: FakeES.open.length,
  resizeObservers: resizeObservers.live(),
  mutationObservers: mutationObservers.live(),
  viewportListeners: viewportListeners.net(),
});

describe('the chat surface leaves exactly one live copy of everything it attaches', () => {
  it('leaves a StrictMode mount holding exactly what a plain mount holds', async () => {
    const plain = renderChat(<main><ChatView /></main>);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    const single = live();
    expect(single.streams).toBe(1);
    // The keyboard geometry is one listener pair on the visual viewport, not one per mount pass.
    expect(single.viewportListeners).toEqual({ resize: 1, scroll: 1 });
    plain.unmount();
    // Unmounting has to give all of it back, or a route change would accumulate copies.
    expect(live().viewportListeners).toEqual({});
    expect(live().resizeObservers).toBe(0);
    expect(live().mutationObservers).toBe(0);

    // StrictMode mounts, unmounts and remounts every effect. Whatever the first pass attached, its
    // cleanup has to have taken away: the survivor count must match a plain mount exactly.
    FakeES.instances.length = 0;
    renderChat(<StrictMode><main><ChatView /></main></StrictMode>);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    expect(live()).toEqual(single);
  });

  it('leaves nothing behind when the reader navigates away from /chat and back', async () => {
    function Router() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen((value) => !value)}>toggle chat</button>
          {open ? <main><ChatView /></main> : <main>dashboard</main>}
        </>
      );
    }
    renderChat(<Router />);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    const mounted = live();

    // Away…
    fireEvent.click(screen.getByText('toggle chat'));
    await screen.findByText('dashboard');
    expect(live().resizeObservers).toBeLessThan(mounted.resizeObservers);
    expect(live().viewportListeners).toEqual({});

    // …and back. The provider outlives the route (that is the point of the single controller), so the
    // stream count must not grow either.
    fireEvent.click(screen.getByText('toggle chat'));
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(live().viewportListeners).toEqual({ resize: 1, scroll: 1 }));
    expect(live().resizeObservers).toBe(mounted.resizeObservers);
    expect(live().mutationObservers).toBe(mounted.mutationObservers);
    expect(FakeES.open.length).toBe(1);
  });

  it('keeps one copy across a background/foreground round trip', async () => {
    renderChat(<main><ChatView /></main>);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    const before = live();

    for (const hidden of [true, false]) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    }
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    expect(live().resizeObservers).toBe(before.resizeObservers);
    expect(live().mutationObservers).toBe(before.mutationObservers);
    expect(live().viewportListeners).toEqual(before.viewportListeners);
  });

  it('keeps one copy when the conversation is switched', async () => {
    renderChat(<main><ChatView /></main>);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    const before = live();

    // The daemon rolls the conversation over on the open stream; the controller rebinds in place.
    FakeES.instances[0]!.emit('session', { sessionId: 'brain-2' });
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-2', history: [], events: [], hasMore: false, nextBefore: null,
    });
    await waitFor(() => expect(FakeES.open.length).toBe(1));
    expect(live().resizeObservers).toBe(before.resizeObservers);
    expect(live().mutationObservers).toBe(before.mutationObservers);
    expect(live().viewportListeners).toEqual(before.viewportListeners);
  });
});

/** The actions value is the one thing in the split that is deliberately FROZEN: it keeps a single identity
 *  for the provider's lifetime so a memoized consumer can rest on it. That is exactly the shape a stale
 *  closure hides in — a handler that never changes identity is easy to leave holding the state it was
 *  created with. Every test below calls an action captured at MOUNT and checks the daemon was asked to do
 *  the CURRENT thing. */
describe('the actions value is stable without going stale', () => {
  /** Captures the first render's actions object and every identity the value has ever had. */
  function CaptureActions({ box }: { box: { first?: BrainChatActions; identities: Set<unknown>; submits: Set<unknown> } }) {
    const actions = useBrainChat();
    box.first ??= actions;
    box.identities.add(actions);
    box.submits.add(actions.submit);
    return null;
  }

  const capture = () => ({ identities: new Set<unknown>(), submits: new Set<unknown>() } as { first?: BrainChatActions; identities: Set<unknown>; submits: Set<unknown> });

  it('keeps one identity through a StrictMode mount and a streamed turn', async () => {
    const box = capture();
    renderChat(<StrictMode><CaptureActions box={box} /><main><ChatView /></main></StrictMode>);
    await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));

    // Booting the conversation legitimately moves this value: the session id, the model and the command
    // catalog all land after mount. What must not move it is the stream.
    const settled = box.identities.size;
    const stream = FakeES.instances.find((s) => !s.closed)!;
    for (let i = 0; i < 5; i++) stream.emit('text', { delta: 'token ' });
    expect(box.identities.size, 'a streamed token changed the actions value').toBe(settled);
    // StrictMode renders every component twice and runs every effect twice. A wrapper built in a render
    // body rather than held in state would hand out a new identity on each of those passes — including
    // across the boot renders above, which this set has been watching the whole time.
    expect(box.submits.size, 'an action changed identity').toBe(1);
  });

  it('sends the draft as it is now, not as it was when the handler was created', async () => {
    const box = capture();
    renderChat(<><CaptureActions box={box} /><main><ChatView /></main></>);
    const composer = await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));

    fireEvent.change(composer, { target: { value: 'ahoj' } });
    fireEvent.change(composer, { target: { value: 'ahoj, jak to jde' } });
    // The action captured on the FIRST render — before any of that text existed.
    await act(async () => { await box.first!.submit(); });
    await waitFor(() => expect(sends.length).toBe(1));
    expect(sends[0]!.text, 'the captured send held a stale draft').toBe('ahoj, jak to jde');
  });

  it('sends in the work mode chosen after the handler was created', async () => {
    const box = capture();
    renderChat(<><CaptureActions box={box} /><main><ChatView /></main></>);
    const composer = await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));

    act(() => { box.first!.setWorkMode('plan'); });
    fireEvent.change(composer, { target: { value: 'navrhni plán' } });
    await act(async () => { await box.first!.submit(); });
    await waitFor(() => expect(sends.length).toBe(1));
    expect(sends[0]!.mode, 'the captured send held the work mode it was created with').toBe('plan');
  });

  it('acts on the conversation the surface is bound to now, after a switch', async () => {
    const box = capture();
    renderChat(<><CaptureActions box={box} /><main><ChatView /></main></>);
    const composer = await screen.findByTestId('chat-composer');
    await waitFor(() => expect(FakeES.open.length).toBe(1));

    // The daemon rolls the conversation over on the open stream; the controller rebinds in place.
    FakeES.instances[0]!.emit('session', { sessionId: 'brain-2' });
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-2', history: [], events: [], hasMore: false, nextBefore: null,
    });

    fireEvent.change(composer, { target: { value: 'druhá konverzace' } });
    await act(async () => { await box.first!.submit(); });
    await waitFor(() => expect(sends.length).toBe(1));
    expect(sends[0]!.session, 'the captured send held the previous conversation').toBe('brain-2');

    act(() => { box.first!.abort(); });
    await waitFor(() => expect(aborts.length).toBe(1));
    expect(aborts[0], 'the captured abort held the previous conversation').toBe('brain-2');
  });
});
