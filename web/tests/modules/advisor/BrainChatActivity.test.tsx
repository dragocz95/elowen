import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';

class FakeES {
  static instances: FakeES[] = [];
  private listeners = new Map<string, ((event: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, handler: (event: { data: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    const event = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

const SNAPSHOT = {
  type: 'snapshot', cursor: 1, history: [], events: [], activitySeq: 4,
  control: { streaming: false, pendingAsk: null, workMode: 'build', pendingPlan: null },
};
const STATUS = {
  running: false, sessionId: 'brain-1', model: 'model', provider: 'provider', providerLabel: 'Provider',
  usage: null, cards: [], queued: [], statusline: null,
};

let activitySeq = 4;
const reads: { sessionId: string; body: unknown }[] = [];
const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', () => HttpResponse.json({ items: [], hasMore: false, nextBefore: null })),
  http.get('*/api/brain/status', () => HttpResponse.json(STATUS)),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{
    id: 'brain-1', title: 'T', provider: 'provider', model: 'model', updated_at: '', running: false, active: true,
    attached: 1, activity: { state: 'done', seq: activitySeq, at: null, detail: 'finished', unread: true },
  }])),
  http.post('*/api/brain/sessions/:id/read', async ({ request, params }) => {
    reads.push({ sessionId: String(params.id), body: await request.json() });
    return HttpResponse.json({ ...STATUS, activity: { state: 'done', seq: activitySeq, readSeq: activitySeq, unread: false } });
  }),
);

function Probe() {
  const { ensureAttached } = useBrainChat();
  useEffect(() => { ensureAttached(); }, [ensureAttached]);
  return null;
}

function renderProbe() {
  const { wrapper: Wrapper } = createWrapper();
  return render(<Wrapper><ToastProvider><BrainChatProvider><Probe /></BrainChatProvider></ToastProvider></Wrapper>);
}

function renderTwoTabs() {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider>
      <BrainChatProvider><Probe /></BrainChatProvider>
      <BrainChatProvider><Probe /></BrainChatProvider>
    </ToastProvider></Wrapper>,
  );
}

beforeAll(() => server.listen({ onUnhandledRequest }));
afterAll(() => server.close());
beforeEach(() => {
  FakeES.instances.length = 0;
  reads.length = 0;
  activitySeq = 4;
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES;
});
afterEach(() => server.resetHandlers());

const liveStreams = () => FakeES.instances.filter((stream) => stream.url.includes('/brain/stream'));
const liveStream = () => liveStreams()[0]!;

describe('web conversation activity acknowledgement', () => {
  it('acknowledges the sequence only after the rendered snapshot', async () => {
    renderProbe();
    await waitFor(() => expect(liveStream()).toBeTruthy());
    expect(reads).toHaveLength(0);

    act(() => { liveStream().emit('snapshot', SNAPSHOT); });
    await waitFor(() => expect(reads).toEqual([{ sessionId: 'brain-1', body: { through: 4, surface: 'web' } }]));
  });

  it('acknowledges a rendered terminal sequence', async () => {
    renderProbe();
    await waitFor(() => expect(liveStream()).toBeTruthy());
    act(() => { liveStream().emit('snapshot', SNAPSHOT); });
    await waitFor(() => expect(reads).toHaveLength(1));

    activitySeq = 5;
    act(() => { liveStream().emit('idle', { type: 'idle', activitySeq: 5 }); });
    await waitFor(() => expect(reads).toEqual([
      { sessionId: 'brain-1', body: { through: 4, surface: 'web' } },
      { sessionId: 'brain-1', body: { through: 5, surface: 'web' } },
    ]));
  });

  it('does not acknowledge a newer session-list sequence before terminal output renders', async () => {
    renderProbe();
    await waitFor(() => expect(liveStream()).toBeTruthy());
    act(() => { liveStream().emit('snapshot', SNAPSHOT); });
    await waitFor(() => expect(reads).toHaveLength(1));

    activitySeq = 6;
    act(() => { liveStream().emit('idle', { type: 'idle', activitySeq: 5 }); });
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]).toEqual({ sessionId: 'brain-1', body: { through: 5, surface: 'web' } });
  });

  it('does not acknowledge while hidden, then acknowledges on visibility return', async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    renderProbe();
    await waitFor(() => expect(liveStream()).toBeTruthy());
    act(() => { liveStream().emit('snapshot', SNAPSHOT); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(reads).toHaveLength(0);

    activitySeq = 5;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(reads).toEqual([{ sessionId: 'brain-1', body: { through: 4, surface: 'web' } }]));
  });

  it('does not let one tab clear a newer result rendered by another tab', async () => {
    renderTwoTabs();
    await waitFor(() => expect(liveStreams()).toHaveLength(2));
    act(() => { liveStreams()[0]!.emit('snapshot', SNAPSHOT); });
    await waitFor(() => expect(reads).toHaveLength(1));

    activitySeq = 5;
    act(() => { liveStreams()[1]!.emit('snapshot', { ...SNAPSHOT, activitySeq: 5 }); });
    await waitFor(() => expect(reads).toEqual([
      { sessionId: 'brain-1', body: { through: 4, surface: 'web' } },
      { sessionId: 'brain-1', body: { through: 5, surface: 'web' } },
    ]));
  });
});
