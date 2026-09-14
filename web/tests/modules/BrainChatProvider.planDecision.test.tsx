import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { ToastProvider } from '../../components/ui/Toast';

// A controllable EventSource stand-in so a test can observe the stream being opened and dispatch the
// server-pushed snapshot frame the provider treats as the proof that data arrived.
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
const brainStatus = vi.fn(async () => ({ running: true, sessionId: 'brain-1', model: 'model-a', usage: null, statusline: null }));
vi.mock('../../lib/elowenClient', () => ({
  BASE: '/api',
  elowenClient: {
    brainStart: (...a: unknown[]) => brainStart(...(a as [])),
    brainMessagesPage: async () => ({ items: [], hasMore: false, nextBefore: null }),
    brainMessages: async () => [],
    brainStatus: (...a: unknown[]) => brainStatus(...(a as [])),
    brainModels: async () => [],
    brainCommands: async () => ({ commands: [] }),
    brainSessions: async () => [],
    brainVisibility: () => {},
  },
}));

import { BrainChatProvider, useBrainChat, useBrainChatStatus, useBrainChatTranscript } from '../../modules/advisor/BrainChatProvider';

/** A status payload that reports plan mode with a pending plan — what a reloaded page hydrates from. */
const planStatus = (sessionId: string) => ({
  running: true, sessionId, model: 'model-a', usage: null, statusline: null,
  workMode: 'plan', pendingPlan: { id: 'call-1', plan: 'refactor the module' },
});

function Harness() {
  const c = { ...useBrainChat(), ...useBrainChatStatus(), ...useBrainChatTranscript() };
  useEffect(() => { c.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <span data-testid="decision">{c.planDecision ? 'plan' : 'none'}</span>
      <span data-testid="notice">{c.notice}</span>
      <button onClick={() => c.dismissPlan()}>dismiss</button>
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

describe('BrainChatProvider plan decision persistence', () => {
  it('keeps a dismissed plan dismissed across a reload instead of re-raising it', async () => {
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-1' }));
    brainStatus.mockImplementation(async () => planStatus('brain-1'));
    const first = renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('plan'));

    fireEvent.click(screen.getByText('dismiss'));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('none'));
    first.unmount();

    // Reload: a fresh mount re-hydrates the same pending plan from the daemon, but the decision persisted
    // for this conversation keeps it from being re-raised.
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('none'));
  });

  it('does not let one conversation\u2019s decision suppress the same plan in another conversation', async () => {
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-1' }));
    brainStatus.mockImplementation(async () => planStatus('brain-1'));
    const first = renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('plan'));
    fireEvent.click(screen.getByText('dismiss'));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('none'));
    first.unmount();

    // A different conversation reports the SAME plan key still pending. The decision was recorded under
    // brain-1, so brain-2 must raise its plan again instead of inheriting the other chat's dismissal.
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-2' }));
    brainStatus.mockImplementation(async () => planStatus('brain-2'));
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId('decision').textContent).toBe('plan'));
  });

  it('shows a connecting notice while the guaranteed first frame is pending and retires it on arrival', async () => {
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-1' }));
    brainStatus.mockImplementation(async () => ({ running: true, sessionId: 'brain-1', model: 'model-a', usage: null, statusline: null }));
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // The stream is open but the guaranteed snapshot frame has not arrived — the composer looks ready, so
    // the notice is the only cue that data is still on its way.
    expect(screen.getByTestId('notice').textContent).toBe('Connecting…');

    await act(async () => {
      FakeEventSource.instances[0].emit('snapshot', JSON.stringify({
        type: 'snapshot', sessionId: 'brain-1', history: [], events: [], hasMore: false, nextBefore: null,
      }));
    });
    await waitFor(() => expect(screen.getByTestId('notice').textContent).toBe(''));
  });
});
