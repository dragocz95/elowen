import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

// The stream's first frame is the hydration: durable history plus the running turn's tail, captured
// atomically server-side. It is what closes the transcript gap a phone lock opens, and it is why the
// controller must NOT also fetch history on connect — the server withholds from the frame exactly those
// user rows it replays as ordering markers, so running both would double them.

/** EventSource stand-in that can deliver frames to the registered listeners. */
class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  closed = false;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

let historyPageRequests = 0;

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => {
    if (!new URL(request.url).searchParams.has('limit')) return HttpResponse.json([]);
    historyPageRequests += 1;
    return HttpResponse.json({
      items: [{ role: 'user', text: 'repaired from durable history', id: 'd1' }],
      hasMore: false, nextBefore: null,
    });
  }),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; historyPageRequests = 0; vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderChat(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

describe('BrainChat snapshot hydration', () => {
  it('opens the stream asking for a snapshot page and does not fetch history alongside it', async () => {
    const es = await renderChat();
    const params = new URL(es.url, 'http://localhost').searchParams;
    expect(params.get('snapshot')).toBe('1');
    expect(params.get('history')).toBe('50');
    expect(params.get('session')).toBe('brain-1');
    await new Promise((r) => setTimeout(r, 20));
    expect(historyPageRequests).toBe(0);
  });

  it('opens and renders the history snapshot while the independent status read is still pending', async () => {
    let resolveStatus!: () => void;
    server.use(http.get('*/api/brain/status', async () => {
      await new Promise<void>((resolve) => { resolveStatus = resolve; });
      return HttpResponse.json({
        running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [],
        queued: [{ id: 'q1', text: 'queued while away' }],
      });
    }));

    const es = await renderChat();
    es.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null,
      history: [{ role: 'user', text: 'visible before status', id: 'm1' }], events: [],
      session: { model: 'm', provider: 'test' }, cards: [],
    });
    await screen.findByText('visible before status');
    await act(async () => resolveStatus());
    await screen.findByText('queued while away');
  });

  it('replaces the transcript from the frame, so a repeated snapshot cannot double a rendered turn', async () => {
    const es = await renderChat();
    const frame = {
      type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null,
      history: [{ role: 'user', text: 'ahoj odsud', id: 'm1' }],
      events: [{ type: 'user', text: 'a jeste tohle' }, { type: 'text', delta: 'pracuji' }],
    };
    es.emit('snapshot', frame);
    await waitFor(() => expect(screen.getAllByText('ahoj odsud')).toHaveLength(1));
    expect(screen.getAllByText('a jeste tohle')).toHaveLength(1);

    es.emit('snapshot', frame); // a second reconnect frame for the same state
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getAllByText('ahoj odsud')).toHaveLength(1);
    expect(screen.getAllByText('a jeste tohle')).toHaveLength(1);
  });

  it('refetches durable history at idle when the frame reported a truncated journal', async () => {
    const es = await renderChat();
    es.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', truncated: true, hasMore: false, nextBefore: null,
      history: [], events: [{ type: 'text', delta: 'tail of a run whose start was dropped' }],
    });
    expect(historyPageRequests).toBe(0); // a live turn is not repaired from a still-incomplete history

    es.emit('idle', {});
    await waitFor(() => expect(historyPageRequests).toBe(1));
    await screen.findByText('repaired from durable history');

    es.emit('idle', {}); // one repair per truncated frame, not on every settle
    await new Promise((r) => setTimeout(r, 20));
    expect(historyPageRequests).toBe(1);
  });

  it('does not refetch when the truncated frame already carried the terminal event', async () => {
    const es = await renderChat();
    es.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', truncated: true, hasMore: false, nextBefore: null,
      history: [{ role: 'user', text: 'settled', id: 'm1' }],
      events: [{ type: 'text', delta: 'complete answer' }, { type: 'idle' }],
    });
    es.emit('idle', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(historyPageRequests).toBe(0);
  });
});
