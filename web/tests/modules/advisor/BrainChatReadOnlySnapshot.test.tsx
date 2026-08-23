import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';

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
  emitRaw(type: string) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({}); });
  }
  listenerCount(type: string) { return this.listeners.get(type)?.length ?? 0; }
}

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-parent' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-parent', model: 'parent-model', provider: 'anthropic', usage: null, statusline: null, cards: [{ id: 'parent', title: 'Parent card' }], queued: [],
  })),
  http.get('*/api/brain/messages', () => HttpResponse.json([{ id: 'parent-message', role: 'assistant', text: 'parent history' }])),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function Harness() {
  const chat = useBrainChat();
  useEffect(() => { chat.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <button onClick={() => { void chat.openReadOnly('brain-child'); }}>open child</button>
    <span data-testid="model">{chat.currentModel}</span>
    <span data-testid="cards">{chat.cards.map((card) => card.title).join(',')}</span>
    <span data-testid="read-only">{chat.readOnly ?? 'live'}</span>
    <span data-testid="busy">{chat.busy ? 'busy' : 'idle'}</span>
    <span data-testid="turn-count">{chat.turns.length}</span>
    <span data-testid="turns">{JSON.stringify(chat.turns)}</span>
  </>;
}

describe('read-only child snapshot', () => {
  it('hydrates the child model and cards from its stream, then upserts live child cards', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));

    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;
    const params = new URL(child.url, 'http://localhost').searchParams;
    expect(params.get('session')).toBe('brain-child');
    expect(params.get('snapshot')).toBe('1');
    expect(params.get('heartbeat')).toBe('1');
    expect(child.listenerCount('heartbeat')).toBe(1);
    // A drill-in must NOT carry the parent client attachment identity: with client+generation the daemon's
    // resolveStreamSession runs its owned-user-session branch and rejects the channel child as `unknown
    // session`, which is exactly why web drill-in was hanging while the CLI (which omits them) worked.
    expect(params.get('client')).toBeNull();
    expect(params.get('generation')).toBeNull();

    child.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-child', session: { model: 'child-model', provider: 'openai-codex' },
      history: [{ id: 'child-message', role: 'assistant', text: 'child history' }], events: [], cards: [{ id: 'child', title: 'Child card' }],
    });
    await waitFor(() => expect(screen.getByTestId('model')).toHaveTextContent('child-model'));
    expect(screen.getByTestId('cards')).toHaveTextContent('Child card');
    expect(screen.getByTestId('cards')).not.toHaveTextContent('Parent card');

    child.emit('card', { card: { id: 'child-live', title: 'Child live card', body: 'live' } });
    await waitFor(() => expect(screen.getByTestId('cards')).toHaveTextContent('Child live card'));
  });

  it('continues folding a running child tool authoring stream after the snapshot', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;
    child.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-child', session: { model: 'child-model', provider: 'openai-codex' },
      history: [], events: [], cards: [],
      control: { streaming: true, pendingAsk: null, workMode: 'build', pendingPlan: null },
    });

    child.emit('tool_authoring', { type: 'tool_authoring', name: 'Bash', detail: 'npm test', reason: 'Running child tests…' });
    await waitFor(() => expect(screen.getByTestId('turns')).toHaveTextContent('Running child tests'));

    child.emit('tool', { type: 'tool', name: 'Bash', detail: 'npm test', id: 'child-tool' });
    await waitFor(() => expect(screen.getByTestId('turns')).not.toHaveTextContent('Running child tests'));
    expect(screen.getByTestId('turns')).toHaveTextContent('child-tool');
  });

  it('leaves a native transport error to EventSource auto-reconnect', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;

    child.emitRaw('error');

    expect(child.closed).toBe(false);
    expect(FakeES.instances).toHaveLength(2);
    expect(screen.getByTestId('read-only')).toHaveTextContent('brain-child');
  });

  it('folds a child turn error after the snapshot without leaving drill-in', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;
    child.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-child', session: { model: 'child-model', provider: 'openai-codex' },
      history: [{ id: 'child-message', role: 'assistant', text: 'child history' }], events: [], cards: [],
      control: { streaming: true, pendingAsk: null, workMode: 'build', pendingPlan: null },
    });
    await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('busy'));

    child.emit('error', { type: 'error', message: 'rate limited' });

    await waitFor(() => expect(screen.getByTestId('busy')).toHaveTextContent('idle'));
    expect(screen.getByTestId('turns')).toHaveTextContent('rate limited');
    expect(child.closed).toBe(false);
    expect(screen.getByTestId('read-only')).toHaveTextContent('brain-child');
  });

  it('treats a server error after transport reconnect as a new unresolved tap', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;
    child.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-child', session: { model: 'child-model', provider: 'openai-codex' },
      history: [{ id: 'child-message', role: 'assistant', text: 'child history' }], events: [], cards: [],
    });
    child.emitRaw('open');

    child.emit('error', { type: 'error', message: 'unknown session' });

    await waitFor(() => expect(child.closed).toBe(true));
    expect(screen.getByTestId('read-only')).toHaveTextContent('live');
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(2));
  });

  it('closes an unresolved child tap and clears its transcript before reconnecting the parent', async () => {
    const { wrapper } = createWrapper();
    render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
    await waitFor(() => expect(FakeES.instances).toHaveLength(1));
    await act(async () => { fireEvent.click(screen.getByText('open child')); });
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    const child = FakeES.instances[1]!;

    child.emit('error', { type: 'error', message: 'unknown session' });

    await waitFor(() => expect(child.closed).toBe(true));
    expect(screen.getByTestId('read-only')).toHaveTextContent('live');
    expect(screen.getByTestId('turn-count')).toHaveTextContent('0');
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(2));
  });
});
