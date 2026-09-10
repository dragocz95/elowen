import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '../test-utils';
import { ToastProvider } from '../../components/ui/Toast';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  close = vi.fn();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(): void {}
}
vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);

const brainStart = vi.fn(async () => ({ sessionId: 'brain-1', created: false }));
vi.mock('../../lib/elowenClient', () => ({
  BASE: '/api',
  elowenClient: {
    brainStart: (...a: unknown[]) => brainStart(...(a as [])),
    brainMessagesPage: async () => ({ items: [], hasMore: false, nextBefore: null }),
    brainMessages: async () => [],
    brainStatus: async () => ({ running: true, sessionId: 'brain-1', model: 'model-a', usage: null, statusline: null }),
    brainModels: async () => [],
    brainCommands: async () => ({ commands: [] }),
    brainSessions: async () => [],
    brainVisibility: () => {},
  },
}));

import { BrainChatProvider, useBrainChat } from '../../modules/advisor/BrainChatProvider';

function Harness() {
  const c = useBrainChat();
  useEffect(() => { c.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <span data-testid="choice">{c.projectChoiceOpen ? 'open' : 'closed'}</span>;
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

describe('BrainChatProvider project choice on connect', () => {
  it('asks about the project when opening the chat had to create the conversation', async () => {
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-1', created: true }));
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('choice').textContent).toBe('open'));
    expect(brainStart).toHaveBeenCalledTimes(1);
  });

  it('resumes an existing conversation without asking', async () => {
    brainStart.mockImplementation(async () => ({ sessionId: 'brain-1', created: false }));
    renderChat();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(screen.getByTestId('choice').textContent).toBe('closed');
  });
});
