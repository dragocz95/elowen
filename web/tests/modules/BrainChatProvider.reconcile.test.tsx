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
const brainMessages = vi.fn(async () => []);
const brainStatus = vi.fn(async () => ({ running: true, sessionId: 'brain-1', model: 'model-a', usage: null, statusline: null }));
const brainSetModel = vi.fn(async () => ({ model: 'model-b' }));
vi.mock('../../lib/elowenClient', () => ({
  BASE: '/api',
  elowenClient: {
    brainStart: (...a: unknown[]) => brainStart(...(a as [])),
    brainMessages: (...a: unknown[]) => brainMessages(...(a as [])),
    brainStatus: (...a: unknown[]) => brainStatus(...(a as [])),
    brainSetModel: (...a: unknown[]) => brainSetModel(...(a as [])),
    brainModels: async () => [],
    brainCommands: async () => ({ commands: [] }),
    brainSessions: async () => [],
  },
}));

import { BrainChatProvider, useBrainChat } from '../../modules/advisor/BrainChatProvider';

const FIX_MODEL: BrainModelOption = {
  provider: 'p', providerLabel: 'P', model: 'model-b', exec: 'elowen:p/model-b',
  source: 'oauth', contextWindow: 200_000, contextWindowSet: true,
};

function Harness() {
  const c = useBrainChat();
  useEffect(() => { c.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <span data-testid="turns">{c.turns.length}</span>
      <span data-testid="draft">{c.input}</span>
      <button onClick={() => c.setInput('unsent draft')}>type</button>
      <button onClick={() => c.setModel(FIX_MODEL)}>switch</button>
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
    // Initial connect: exactly one stream, one history load.
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(brainMessages).toHaveBeenCalledTimes(1));

    // A model switch: it hits POST /brain/model but opens NO new EventSource and does NOT reload history
    // (the reconcile arrives over the still-open stream).
    await act(async () => { fireEvent.click(screen.getByText('switch')); });
    await waitFor(() => expect(brainSetModel).toHaveBeenCalledTimes(1));
    expect(FakeEventSource.instances).toHaveLength(1); // no SSE teardown/reopen — invariant 1
    expect(brainMessages).toHaveBeenCalledTimes(1); // runModel never reloads history

    // The daemon pushes the reconcile on the SAME stream: exactly one history refetch, and no fabricated
    // 'user' turn (session-event is not a transcript reset).
    await act(async () => { FakeEventSource.instances[0]!.emit('session-event', '{}'); });
    await waitFor(() => expect(brainMessages).toHaveBeenCalledTimes(2));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByTestId('turns').textContent).toBe('0'); // no duplicate/extra turn
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
});
