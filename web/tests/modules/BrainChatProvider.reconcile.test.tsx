import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { ToastProvider } from '../../components/ui/Toast';
import type { BrainModelOption } from '../../lib/types';

// A controllable EventSource stand-in: counts constructions (a model switch must open NO new stream) and
// lets a test dispatch a server-pushed `session-event` to the registered listener.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  private listeners = new Map<string, (e: unknown) => void>();
  close = vi.fn();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(type: string, handler: (e: unknown) => void): void { this.listeners.set(type, handler); }
  emit(type: string, data: string): void { this.listeners.get(type)?.({ data } as unknown); }
}
vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

const brainStart = vi.fn(async () => ({ sessionId: 'brain-1' }));
// The live chat boots + refetches history through the PAGED endpoint (brainMessagesPage); brainMessages
// (bare) is only the read-only path, unused here but kept so the mock matches the client surface.
// Typed explicitly: inferred from the empty default page, `items` would be never[] and `nextBefore` null,
// so any test seeding a real page fails to typecheck.
type HistoryPage = { items: { id: string; role: string; text: string }[]; hasMore: boolean; nextBefore: number | null };
const brainMessagesPage = vi.fn(async (): Promise<HistoryPage> => ({ items: [], hasMore: false, nextBefore: null }));
const brainMessages = vi.fn(async () => []);
const brainStatus = vi.fn(async () => ({ running: true, sessionId: 'brain-1', model: 'model-a', usage: null, statusline: null }));
const brainSetModel = vi.fn(async () => ({ model: 'gpt-5.6-sol' }));
const brainAnswer = vi.fn(async () => ({ ok: true, matched: true }));
vi.mock('../../lib/elowenClient', () => ({
  BASE: '/api',
  elowenClient: {
    brainStart: (...a: unknown[]) => brainStart(...(a as [])),
    brainMessagesPage: (...a: unknown[]) => brainMessagesPage(...(a as [])),
    brainMessages: (...a: unknown[]) => brainMessages(...(a as [])),
    brainStatus: (...a: unknown[]) => brainStatus(...(a as [])),
    brainSetModel: (...a: unknown[]) => brainSetModel(...(a as [])),
    brainAnswer: (...a: unknown[]) => brainAnswer(...(a as [])),
    brainModels: async () => [],
    brainCommands: async () => ({ commands: [] }),
    brainSessions: async () => [],
    brainVisibility: () => {},
  },
}));

import { BrainChatProvider, useBrainChat, useBrainChatInput } from '../../modules/advisor/BrainChatProvider';

const FIX_MODEL: BrainModelOption = {
  provider: 'chatgpt-account', providerLabel: 'Účet ChatGPT', model: 'gpt-5.6-sol', exec: 'chatgpt-account/gpt-5.6-sol',
  source: 'oauth', contextWindow: 200_000, contextWindowSet: true,
};

function Harness() {
  const c = useBrainChat();
  const input = useBrainChatInput();
  useEffect(() => { c.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <span data-testid="turns">{c.turns.length}</span>
      <span data-testid="draft">{input}</span>
      <span data-testid="hasMore">{c.hasMoreHistory ? 'yes' : 'no'}</span>
      <span data-testid="ask">{c.ask?.id ?? 'none'}</span>
      <button onClick={() => c.setInput('unsent draft')}>type</button>
      <button onClick={() => { if (c.ask) void c.onAnswer(c.ask.id, [{ header: 'Choice', selected: ['A'] }]).catch(() => undefined); }}>answer</button>
      <button onClick={() => c.setModel(FIX_MODEL)}>switch</button>
      <button onClick={() => { void c.loadOlder(); }}>older</button>
    </div>
  );
}

const renderChat = () =>
  render(
    <ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>,
    { wrapper: createWrapper().wrapper },
  );

beforeEach(() => {
  FakeEventSource.instances.length = 0;
  vi.clearAllMocks();
});

describe('BrainChatProvider model-switch reconcile', () => {
  it('switches the model without tearing down / reopening the SSE, and the pushed session-event refetches history once with no duplicate turn', async () => {
    renderChat();
    // Initial connect: exactly one stream and NO history fetch — the stream's snapshot frame hydrates.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(brainMessagesPage).not.toHaveBeenCalled();

    // A model switch: it hits POST /brain/model but opens NO new EventSource and does NOT reload history
    // (the reconcile arrives over the still-open stream).
    await act(async () => { fireEvent.click(screen.getByText('switch')); });
    await waitFor(() => expect(brainSetModel).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Switched to gpt-5\.6-sol|Přepnuto na gpt-5\.6-sol/)).toBeInTheDocument();
    expect(screen.queryByText(/Účet ChatGPT\/gpt-5\.6-sol/)).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1); // no SSE teardown/reopen — invariant 1
    expect(brainMessagesPage).not.toHaveBeenCalled(); // runModel never reloads history

    // The daemon pushes the reconcile on the SAME stream: exactly one history refetch, and no fabricated
    // 'user' turn (session-event is not a transcript reset).
    await act(async () => { FakeEventSource.instances[0]!.emit('session-event', '{}'); });
    await waitFor(() => expect(brainMessagesPage).toHaveBeenCalledTimes(1));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByTestId('turns').textContent).toBe('0'); // no duplicate/extra turn
  });

  it('an idle rollover (session event) closes the lazy-load window so a stale cursor cannot re-page the new session', async () => {
    // Boot with an open window (more history remains, cursor mid-stream) — the snapshot frame carries it.
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => {
      FakeEventSource.instances[0]!.emit('snapshot', JSON.stringify({
        type: 'snapshot', sessionId: 'brain-1', history: [{ id: 'm1', role: 'user', text: 'q' }],
        events: [], hasMore: true, nextBefore: 1,
      }));
    });
    await waitFor(() => expect(screen.getByTestId('hasMore').textContent).toBe('yes'));
    const pagedCalls = brainMessagesPage.mock.calls.length;

    // The daemon rolls the idle conversation into a fresh one on the SAME stream.
    await act(async () => { FakeEventSource.instances[0]!.emit('session', JSON.stringify({ sessionId: 'brain-2' })); });
    expect(screen.getByTestId('hasMore').textContent).toBe('no'); // window closed → no scroll-up sentinel

    // A scroll-up now must be a no-op: the cursor was reset to null, so loadOlder never re-pages (which would
    // otherwise double the rolled-over session's just-shown turns).
    await act(async () => { fireEvent.click(screen.getByText('older')); });
    expect(brainMessagesPage.mock.calls.length).toBe(pagedCalls);
  });

  it('a pushed title event refetches the sessions registry once — no transcript turn, no SSE reconnect, no history reload', async () => {
    const { client, wrapper } = createWrapper();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    invalidate.mockClear(); // isolate the event from any connect-time invalidations

    // The background titler lands its generated name on the SAME stream, after the first turn settled.
    await act(async () => { FakeEventSource.instances[0]!.emit('title', JSON.stringify({ title: 'Generated name' })); });
    // Exactly one invalidation of the authoritative registry query — the same path a manual rename takes.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['brain-sessions'] }));
    expect(invalidate.mock.calls.filter(([f]) => JSON.stringify((f as { queryKey?: unknown } | undefined)?.queryKey) === JSON.stringify(['brain-sessions']))).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1); // metadata signal: no SSE teardown/reopen
    expect(screen.getByTestId('turns').textContent).toBe('0'); // and no fabricated transcript turn
    expect(brainMessagesPage).not.toHaveBeenCalled(); // title never reloads history
  });

  it('a header/dock model switch preserves the composer draft (never wipes unsent text)', async () => {
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // The user types but has not sent, then changes model from the header picker.
    await act(async () => { fireEvent.click(screen.getByText('type')); });
    expect(screen.getByTestId('draft').textContent).toBe('unsent draft');
    await act(async () => { fireEvent.click(screen.getByText('switch')); });
    await waitFor(() => expect(brainSetModel).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('draft').textContent).toBe('unsent draft'); // draft survives the switch
  });

  it('keeps the pending prompt and reports a fail-soft error when answer returns matched:false', async () => {
    brainAnswer.mockResolvedValueOnce({ ok: true, matched: false });
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(async () => {
      FakeEventSource.instances[0]!.emit('ask', JSON.stringify({
        id: 'ask-1',
        questions: [{ question: 'Pick one?', header: 'Choice', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      }));
    });
    expect(screen.getByTestId('ask').textContent).toBe('ask-1');

    await act(async () => { fireEvent.click(screen.getByText('answer')); });

    await waitFor(() => expect(brainAnswer).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('ask').textContent).toBe('ask-1');
    expect(await screen.findByText(/The answer was not sent|Odpověď se nepodařilo odeslat/)).toBeInTheDocument();
  });
});
