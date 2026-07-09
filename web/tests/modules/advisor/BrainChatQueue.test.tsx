import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';

/** Minimal EventSource stand-in: BrainChat registers per-event listeners on it and we drive them by
 *  hand (the same pattern as useElowenEvents.test.tsx). `instances` lets a test grab the live stream. */
class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  closed = false;
  readyState = 0;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

const removed: string[] = [];
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', () => HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.delete('*/api/brain/queue/:id', ({ params }) => { removed.push(String(params['id'])); return HttpResponse.json({ removed: true }); }),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  // jsdom has no Element.scrollTo — the transcript autoscroll effect calls it.
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); removed.length = 0; FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChat /></ToastProvider></Wrapper>);
}

describe('BrainChat pending queue', () => {
  it('renders a `queue` snapshot as removable chips and DELETEs the item on ×', async () => {
    renderChat();
    // The stream connects after brainStart/history/status resolve.
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0]!;

    // A full-snapshot queue event → two pending chips with a "Queued" badge, no premature user bubbles.
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'check the logs' }, { id: 'q2', text: 'and the metrics' }] }));
    expect(await screen.findByText('check the logs')).toBeTruthy();
    expect(screen.getByText('and the metrics')).toBeTruthy();
    expect(screen.getAllByText(/Queued|Ve frontě/i).length).toBe(2);

    // Clicking × on the first chip optimistically drops it AND DELETEs /brain/queue/q1.
    const removeButtons = screen.getAllByRole('button', { name: /Remove from queue|Odebrat z fronty/i });
    act(() => fireEvent.click(removeButtons[0]!));
    await waitFor(() => expect(removed).toEqual(['q1']));
    expect(screen.queryByText('check the logs')).toBeNull(); // optimistic removal
    expect(screen.getByText('and the metrics')).toBeTruthy();

    // A follow-up snapshot from the server is authoritative (a drain clears everything).
    act(() => es.emit({ type: 'queue', items: [] }));
    await waitFor(() => expect(screen.queryByText('and the metrics')).toBeNull());
  });

  it('folds a `user` delivery event into a you-turn bubble', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0]!;
    act(() => es.emit({ type: 'user', text: 'combined queued delivery' }));
    expect(await screen.findByText('combined queued delivery')).toBeTruthy();
  });

  it('never echoes optimistically — the you-bubble renders ONLY from the daemon `user` event (no dupes)', async () => {
    let sent: { text?: string } | null = null;
    server.use(http.post('*/api/brain/send', async ({ request }) => { sent = (await request.json()) as { text?: string }; return HttpResponse.json({ ok: true }); }));
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0]!;
    const textarea = screen.getByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'hello there' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });
    // The send POSTed the message, but the composer did NOT push an optimistic 'you' bubble.
    await waitFor(() => expect(sent).toBeTruthy());
    expect(sent!.text).toBe('hello there');
    expect(screen.queryByText('hello there')).toBeNull();
    // The daemon's authoritative `user` event is what renders the 'you' turn — exactly once, no dupe.
    act(() => es.emit({ type: 'user', text: 'hello there' }));
    expect(await screen.findByText('hello there')).toBeTruthy();
    expect(screen.getAllByText('hello there')).toHaveLength(1);
  });
});
