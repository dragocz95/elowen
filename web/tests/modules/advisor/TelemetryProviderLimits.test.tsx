import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { useEffect } from 'react';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

let rateLimitFetches = 0;
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', () => HttpResponse.json({ items: [], hasMore: false, nextBefore: null })),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'gpt', provider: 'codex-account', providerLabel: 'Codex', usageProvider: 'openai-codex', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/rate-limits/all', () => {
    rateLimitFetches += 1;
    return HttpResponse.json({
      'openai-codex': {
        provider: 'openai-codex', planType: 'parent-plan', windows: [{ usedPercent: 70, windowMinutes: 300, resetsAt: null }], fetchedAt: 0, stale: false,
      },
      anthropic: {
        provider: 'anthropic', planType: 'child-plan', windows: [{ usedPercent: 20, windowMinutes: 300, resetsAt: null }], fetchedAt: 0, stale: false,
      },
    });
  }),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; rateLimitFetches = 0; });
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function Attach() {
  const chat = useBrainChat();
  useEffect(() => { chat.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <button type="button" onClick={() => void chat.openReadOnly('brain-ch-subagent-child')}>Open child</button>;
}

describe('telemetry provider usage cache', () => {
  it('shows the drilled-in child provider limits instead of the parent account', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Attach /><TelemetryPanel variant="column" /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await waitFor(() => expect(rateLimitFetches).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('telemetry-limits')).toHaveTextContent('parent-plan'));

    fireEvent.click(screen.getByRole('button', { name: 'Open child' }));
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    // Before the child's atomic snapshot arrives, parent telemetry is deliberately cleared.
    expect(screen.queryByTestId('telemetry-limits')).toBeNull();
    FakeES.instances[1]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-ch-subagent-child', history: [], events: [], cards: [],
      session: { model: 'claude', provider: 'claude-account', providerLabel: 'Claude', usageProvider: 'anthropic' },
      control: { streaming: false, pendingAsk: null, workMode: 'build', pendingPlan: null },
      hasMore: false, nextBefore: null,
    });

    await waitFor(() => expect(screen.getByTestId('telemetry-limits')).toHaveTextContent('child-plan'));
    expect(screen.getByTestId('telemetry-limits')).not.toHaveTextContent('parent-plan');
  });
});
