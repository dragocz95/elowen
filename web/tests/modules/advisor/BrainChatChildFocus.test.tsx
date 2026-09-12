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

const subagentSends: { session: string; text: string }[] = [];
const aborts: (string | undefined)[] = [];
const parentSends: unknown[] = [];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-parent' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-parent', model: 'parent-model', provider: 'anthropic', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/messages', () => HttpResponse.json([{ id: 'parent-message', role: 'assistant', text: 'parent history' }])),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.post('*/api/brain/subagent/send', async ({ request }) => {
    const body = await request.json() as { session: string; text: string };
    subagentSends.push(body);
    return HttpResponse.json({ ok: true });
  }),
  http.post('*/api/brain/send', async ({ request }) => {
    parentSends.push(await request.json());
    return HttpResponse.json({ ok: true });
  }),
  http.post('*/api/brain/abort', async ({ request }) => {
    const body = await request.json() as { session?: string };
    aborts.push(body.session);
    return HttpResponse.json({ ok: true });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  subagentSends.length = 0;
  aborts.length = 0;
  parentSends.length = 0;
});
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function Harness() {
  const chat = useBrainChat();
  useEffect(() => { chat.ensureAttached(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <>
    <button onClick={() => { void chat.focusSubagentSession('brain-child'); }}>focus child</button>
    <button onClick={() => chat.exitChildFocus()}>exit child</button>
    <button onClick={() => { chat.setInput('guide the child'); void chat.submit(); }}>submit</button>
    <button onClick={() => chat.abort()}>stop</button>
    <span data-testid="child-focus">{chat.childFocus ?? 'none'}</span>
    <span data-testid="read-only">{chat.readOnly ?? 'live'}</span>
    <span data-testid="draft">{chat.draft.getSnapshot()}</span>
  </>;
}

const renderHarness = async () => {
  const { wrapper } = createWrapper();
  render(<ToastProvider><BrainChatProvider><Harness /></BrainChatProvider></ToastProvider>, { wrapper });
  await waitFor(() => expect(FakeES.instances).toHaveLength(1));
  await act(async () => { fireEvent.click(screen.getByText('focus child')); });
  await waitFor(() => expect(FakeES.instances).toHaveLength(2));
  FakeES.instances[1]!.emit('snapshot', {
    type: 'snapshot', sessionId: 'brain-child', session: { model: 'child-model', provider: 'openai-codex' },
    history: [], events: [], cards: [],
  });
  await waitFor(() => expect(screen.getByTestId('child-focus')).toHaveTextContent('brain-child'));
};

describe('BrainChatProvider — a focused delegated child is writable', () => {
  it('opens the child live with the composer (child focus), not as a read-only preview', async () => {
    await renderHarness();

    expect(screen.getByTestId('read-only')).toHaveTextContent('live');
    // The child lane is its own EventSource, session-bound and without the parent client attachment.
    const child = FakeES.instances[1]!;
    const params = new URL(child.url, 'http://localhost').searchParams;
    expect(params.get('session')).toBe('brain-child');
    expect(params.get('client')).toBeNull();
  });

  it('routes a send through the subagent send seam addressed to THAT child — never the parent send', async () => {
    await renderHarness();
    await act(async () => { fireEvent.click(screen.getByText('submit')); });
    await waitFor(() => expect(subagentSends).toEqual([{ session: 'brain-child', text: 'guide the child' }]));
    expect(parentSends).toEqual([]);
  });

  it('exit returns to the live bound conversation and closes the child lane', async () => {
    await renderHarness();
    await act(async () => { fireEvent.click(screen.getByText('exit child')); });
    await waitFor(() => expect(screen.getByTestId('child-focus')).toHaveTextContent('none'));
    expect(FakeES.instances[1]!.closed).toBe(true);
    expect(screen.getByTestId('read-only')).toHaveTextContent('live');
  });

  it('Stop while focused aborts the VIEWED child, never the hidden parent', async () => {
    await renderHarness();
    await act(async () => { fireEvent.click(screen.getByText('stop')); });
    await waitFor(() => expect(aborts).toEqual(['brain-child']));
  });

  it('a refusal keeps the draft and shows the daemon\'s precise reason', async () => {
    server.use(http.post('*/api/brain/subagent/send', () => HttpResponse.json(
      { error: 'delegated access unavailable' }, { status: 409 },
    )));
    await renderHarness();
    await act(async () => { fireEvent.click(screen.getByText('submit')); });
    await waitFor(() => expect(screen.getByTestId('draft')).toHaveTextContent('guide the child'));
  });
});
