import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { openBrainComposer, openBrainSession } from '../../../lib/brainDock';

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
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
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
  return render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
}

describe('BrainChat pending queue', () => {
  it('consumes a dashboard composer draft when the chat dock mounts', async () => {
    openBrainComposer('draft from home');
    renderChat();
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect(textarea).toHaveValue('draft from home'));
    await waitFor(() => expect(document.activeElement).toBe(textarea)); // focus lands on the next animation frame
  });

  it('leaves read-only history, reconnects the personal stream, and preserves a draft on focus-only requests', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));

    act(() => openBrainSession('discord-channel', false));
    expect(await screen.findByText(/Read-only history|Historie jen pro čtení/i)).toBeInTheDocument();

    act(() => openBrainComposer('continue in my chat'));
    const textarea = await screen.findByRole('textbox');
    await waitFor(() => expect(textarea).toHaveValue('continue in my chat'));
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(1));

    act(() => fireEvent.change(textarea, { target: { value: 'unsent draft' } }));
    act(() => openBrainComposer());
    expect(textarea).toHaveValue('unsent draft');
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('appends a dashboard request without overwriting an existing unsent draft', async () => {
    renderChat();
    const textarea = await screen.findByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'existing unsent draft' } }));

    act(() => openBrainComposer('new request from home'));

    expect(textarea).toHaveValue('existing unsent draft\n\nnew request from home');
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it('renders a `queue` snapshot as removable chips and DELETEs the item on ×', async () => {
    renderChat();
    // The stream connects after brainStart/history/status resolve.
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];

    // A full-snapshot queue event → two pending chips with a "Queued" badge, no premature user bubbles.
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'check the logs' }, { id: 'q2', text: 'and the metrics' }] }));
    expect(await screen.findByText('check the logs')).toBeTruthy();
    expect(screen.getByText('and the metrics')).toBeTruthy();
    expect(screen.getAllByText(/Queued|Ve frontě/i).length).toBe(2);

    // Clicking × on the first chip optimistically drops it AND DELETEs /brain/queue/q1.
    const removeButtons = screen.getAllByRole('button', { name: /Remove from queue|Odebrat z fronty/i });
    act(() => fireEvent.click(removeButtons[0]));
    await waitFor(() => expect(removed).toEqual(['q1']));
    expect(screen.queryByText('check the logs')).toBeNull(); // optimistic removal
    expect(screen.getByText('and the metrics')).toBeTruthy();

    // A follow-up snapshot from the server is authoritative (a drain clears everything).
    act(() => es.emit({ type: 'queue', items: [] }));
    await waitFor(() => expect(screen.queryByText('and the metrics')).toBeNull());
  });

  /** A DELETE that hangs until the test releases it, then fails — the window where the UI moves on. */
  function gateQueueRemove(): () => void {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.use(http.delete('*/api/brain/queue/:id', async ({ params }) => {
      removed.push(String(params['id']));
      await held;
      return HttpResponse.json({ error: 'queue gone' }, { status: 500 });
    }));
    return release;
  }

  it('does not resurrect a queue item when the DELETE fails after a session switch', async () => {
    const release = gateQueueRemove();
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'check the logs' }] }));
    expect(await screen.findByText('check the logs')).toBeTruthy();

    act(() => fireEvent.click(screen.getByRole('button', { name: /Remove from queue|Odebrat z fronty/i })));
    await waitFor(() => expect(removed).toEqual(['q1']));

    // Switch to another conversation whose queue has its OWN positional q1 — the id the failing DELETE names.
    server.use(
      http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-2' }, { status: 201 })),
      http.get('*/api/brain/status', () => HttpResponse.json({ running: true, sessionId: 'brain-2', model: 'm', usage: null, statusline: null, cards: [], queued: [{ id: 'q1', text: 'other conversation item' }] })),
    );
    await act(async () => { openBrainSession('brain-2', true); });
    expect(await screen.findByText('other conversation item')).toBeTruthy();

    await act(async () => { release(); await new Promise((r) => setTimeout(r, 50)); });

    // The late failure belongs to the previous conversation: no ghost chip, no toast about an invisible queue.
    expect(screen.queryByText('check the logs')).toBeNull();
    expect(screen.getByText('other conversation item')).toBeTruthy();
    expect(screen.queryByText(/not removed|nepodařilo odebrat|nepodarilo odobrať/i)).toBeNull();
  });

  it('leaves a newer server queue snapshot alone when the DELETE fails afterwards', async () => {
    const release = gateQueueRemove();
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'check the logs' }, { id: 'q2', text: 'and the metrics' }] }));
    expect(await screen.findByText('check the logs')).toBeTruthy();

    act(() => fireEvent.click(screen.getAllByRole('button', { name: /Remove from queue|Odebrat z fronty/i })[0]));
    await waitFor(() => expect(removed).toEqual(['q1']));

    // The server speaks after the request was sent but before it fails: this list is the authoritative truth.
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'drained and refilled' }] }));
    expect(await screen.findByText('drained and refilled')).toBeTruthy();

    await act(async () => { release(); await new Promise((r) => setTimeout(r, 50)); });

    // The failure is reported, but the snapshot stands — no stale item spliced back into it.
    expect(await screen.findByText(/not removed|nepodařilo odebrat|nepodarilo odobrať/i)).toBeTruthy();
    expect(screen.queryByText('check the logs')).toBeNull();
    expect(screen.getByText('drained and refilled')).toBeTruthy();
  });

  it('restores the queue in its own order when two overlapping removes both fail', async () => {
    // The queue order is the order the agent is fed in, so a failed remove must put the item back exactly
    // where it was — including when a second remove is already in flight over the shortened list.
    const release = gateQueueRemove();
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];
    act(() => es.emit({ type: 'queue', items: [{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }, { id: 'q3', text: 'third' }] }));
    expect(await screen.findByText('first')).toBeTruthy();

    const removeButtons = () => screen.getAllByRole('button', { name: /Remove from queue|Odebrat z fronty/i });
    const queueTexts = () => removeButtons().map((button) => button.previousElementSibling?.textContent ?? '');

    act(() => fireEvent.click(removeButtons()[1])); // the middle item
    await waitFor(() => expect(removed).toEqual(['q2']));
    act(() => fireEvent.click(removeButtons()[1])); // the last one — same position in the shortened list
    await waitFor(() => expect(removed).toEqual(['q2', 'q3']));

    await act(async () => { release(); await new Promise((r) => setTimeout(r, 50)); });

    expect(queueTexts()).toEqual(['first', 'second', 'third']);
  });

  it('folds a `user` delivery event into a you-turn bubble', async () => {
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];
    act(() => es.emit({ type: 'user', text: 'combined queued delivery' }));
    expect(await screen.findByText('combined queued delivery')).toBeTruthy();
  });

  it('never echoes optimistically — the you-bubble renders ONLY from the daemon `user` event (no dupes)', async () => {
    let sent: { text?: string } | null = null;
    server.use(http.post('*/api/brain/send', async ({ request }) => { sent = (await request.json()) as { text?: string }; return HttpResponse.json({ ok: true }); }));
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const es = FakeES.instances[0];
    const textarea = screen.getByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'hello there' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });
    // The send POSTed the message, but the composer did NOT push an optimistic 'you' bubble.
    await waitFor(() => expect(sent).toMatchObject({ text: 'hello there' }));
    expect(screen.queryByText('hello there')).toBeNull();
    // The daemon's authoritative `user` event is what renders the 'you' turn — exactly once, no dupe.
    act(() => es.emit({ type: 'user', text: 'hello there' }));
    expect(await screen.findByText('hello there')).toBeTruthy();
    expect(screen.getAllByText('hello there')).toHaveLength(1);
  });

  it('keeps the submitted draft when the daemon rejects a send during a slow session start', async () => {
    server.use(http.post('*/api/brain/send', () => HttpResponse.json({ error: 'brain not started' }, { status: 409 })));
    renderChat();
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
    const textarea = screen.getByRole('textbox');
    act(() => fireEvent.change(textarea, { target: { value: 'do not lose this' } }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Send|Odeslat/i })); });

    await waitFor(() => expect(textarea).toHaveValue('do not lose this'));
    // Scoped to the visible description on purpose. Radix Toast renders the same text a second time in
    // a visually hidden `role="status"` region so a screen reader hears it, and that copy appears a beat
    // after the toast itself — an unscoped `getByText` therefore matches once or twice depending on how
    // far timers happened to advance, which is a flake waiting for a slow run.
    expect(screen.getByText(/Message was not sent|Zprávu se nepodařilo odeslat/i, {
      selector: '[data-slot="toast-description"]',
    })).toBeInTheDocument();
  });
});
