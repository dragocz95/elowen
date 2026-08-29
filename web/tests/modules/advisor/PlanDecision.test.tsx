import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import type { BrainStatus } from '../../../lib/types';

/** Plan mode's decision on the web. The mode is stamped per send and kept by the DAEMON, so everything
 *  here hangs off what the daemon publishes: a decision raised from tab-local state never appeared for a
 *  plan submitted in the CLI, and vanished on reload — the transcript kept the plan and lost the action. */

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(obj: Record<string, unknown>) {
    for (const fn of this.listeners.get(obj['type'] as string) ?? []) fn({ data: JSON.stringify(obj) });
  }
}

const PLAN = '# Ship it\n\n1. Wire the store';
const sent: Record<string, unknown>[] = [];

/** The daemon's status, with the plan-mode fields the surface now reads. */
function statusBody(over: Partial<BrainStatus> = {}): BrainStatus {
  return { running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [], ...over };
}

let status: BrainStatus = statusBody();

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', async ({ request }) => {
    sent.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json({ ok: true });
  }),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json(status)),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; sent.length = 0; status = statusBody(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderSurface(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="compact" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = FakeES.instances[0];
  if (!es) throw new Error('no stream opened');
  return es;
}

/** A settled assistant turn that submitted a plan, as the snapshot frame delivers it after a reload. */
const planHistory = [{
  id: 'm1', role: 'assistant', text: '',
  segments: [{ kind: 'tool', name: 'ExitPlanMode', id: 'call-1', plan: PLAN }],
}];

describe('web plan decision', () => {
  it('raises the modal from the daemon status alone — no local plan mode, no transcript', async () => {
    status = statusBody({ workMode: 'plan', pendingPlan: { id: 'call-1', plan: PLAN } });
    await renderSurface();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Wire the store');
    expect(screen.getByTestId('plan-decision-body')).toHaveTextContent('Ship it');
  });

  it('stays away while the daemon is not in plan mode, even with a plan in the transcript', async () => {
    status = statusBody({ workMode: 'build', pendingPlan: null });
    const es = await renderSurface();
    await act(async () => { es.emit({ type: 'snapshot', history: planHistory, events: [], control: { streaming: false, pendingAsk: null, workMode: 'build', pendingPlan: null } }); });
    await waitFor(() => expect(screen.queryByTestId('chat-plan')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('raises the modal for a plan submitted while the tab is attached, and implements it in build mode', async () => {
    status = statusBody({ workMode: 'plan', pendingPlan: null });
    const es = await renderSurface();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'call-1' });
      es.emit({ type: 'tool_end', id: 'call-1', plan: PLAN });
      es.emit({ type: 'idle' }); // the decision belongs to a SETTLED turn, exactly like the CLI's
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Ship it');

    fireEvent.click(screen.getByTestId('plan-decision-implement'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ text: 'Implement the plan you proposed above.', mode: 'build' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('follows the daemon into plan mode when the turn that entered it settles', async () => {
    // The realistic web journey: the tab connects to a conversation the daemon is still running in build
    // mode, the user picks plan mode HERE, and the plan is submitted in that very session. The mode is
    // committed only once the settled turn's prompt reached the provider, so the connect-time status
    // answered 'build' and nothing else ever republished it — the decision has to follow the settle.
    status = statusBody({ workMode: 'build', pendingPlan: null });
    const es = await renderSurface();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    status = statusBody({ workMode: 'plan', pendingPlan: { id: 'call-1', plan: PLAN } });
    await act(async () => {
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'call-1' });
      es.emit({ type: 'tool_end', id: 'call-1', plan: PLAN });
      es.emit({ type: 'idle' });
    });
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Ship it');
  });

  it('cancelling stays in plan mode and does not raise the same plan again on the next hydration', async () => {
    status = statusBody({ workMode: 'plan', pendingPlan: { id: 'call-1', plan: PLAN } });
    const es = await renderSurface();
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByTestId('plan-decision-cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toHaveLength(0); // dismissing sends nothing — the plan stays open for refining

    // A reconnect re-delivers the very same pending decision; it must not pop back up.
    await act(async () => {
      es.emit({
        type: 'snapshot', history: planHistory, events: [],
        control: { streaming: false, pendingAsk: null, workMode: 'plan', pendingPlan: { id: 'call-1', plan: PLAN } },
      });
    });
    await waitFor(() => expect(screen.queryByTestId('chat-plan')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drops the decision once the conversation moved past the plan, with no new hydration', async () => {
    status = statusBody({ workMode: 'plan', pendingPlan: { id: 'call-1', plan: PLAN } });
    const es = await renderSurface();
    await screen.findByRole('dialog');
    // The user refined the plan instead of implementing it. Nothing re-hydrates here — the daemon's
    // connect-time answer still names the plan — so it is the transcript that has to withdraw the
    // decision once the newest turn is an answer without one.
    await act(async () => {
      es.emit({ type: 'user', text: 'make it smaller' });
      es.emit({ type: 'text', delta: 'sure, here is a tighter one' });
      es.emit({ type: 'idle' });
    });
    await waitFor(() => expect(screen.getByText('make it smaller')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

afterAll(() => vi.restoreAllMocks());
