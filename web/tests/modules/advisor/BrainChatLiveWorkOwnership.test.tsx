import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import type { ProcessInfo } from '../../../lib/types';

/** Background processes belong to the telemetry panel and nowhere else: a long-running command reported
 *  both above the composer and in the rail was the same work announced twice, and the transcript copy is
 *  the one that crowded the conversation. Running AGENTS still fall back to the transcript, because the
 *  chip is one line and a reader with no rail on screen would otherwise have no sign of them at all. */

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  private listeners = new Map<string, ((e: { data?: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

const process1: ProcessInfo = {
  id: 'p1', command: 'sleep 55', cwd: '/var/www/elowen', sessionId: 'brain-1',
  startedAt: '2026-07-27T10:00:00.000Z', running: true, exitCode: null, completionMode: 'service',
};

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => HttpResponse.json([process1])),
  http.get('*/api/brain/processes/:id/output', () => HttpResponse.json({ output: '' })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** Renders the surface with a live process AND a live agent already reported over the stream, so an
 *  assertion that the process row is absent means "the surface refuses to draw it", not "no data arrived".
 *  The agent chip is the arrival signal: it is fed by the same stream in the same act(). */
async function renderSurface(telemetryShown: boolean | undefined): Promise<{ showRail: (shown: boolean) => void }> {
  const { wrapper: Wrapper } = createWrapper();
  const tree = (shown: boolean | undefined) => (
    <Wrapper><ToastProvider><BrainChatProvider>
      <BrainChatSurface variant="full" telemetryShown={shown} />
    </BrainChatProvider></ToastProvider></Wrapper>
  );
  const view = render(tree(telemetryShown));
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const es = FakeES.instances[0]!;
  es.emit('process', { processes: [process1] });
  es.emit('tool', { type: 'tool', name: 'Delegate', id: 'call-1' });
  es.emit('subagent', {
    type: 'subagent', id: 'call-1', sessionId: 'brain-sub-1', status: 'running',
    task: 'sleep 50', tools: 1, seconds: 3,
  });
  return { showRail: (shown: boolean) => act(() => view.rerender(tree(shown))) };
}

describe('live work is reported in one place', () => {
  it('never draws a background process in the transcript, even with no rail to defer to', async () => {
    await renderSurface(undefined);

    // The agent chip proves the stream was consumed, so the missing process row is a decision.
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
    expect(screen.queryByText('Background processes')).toBeNull();
    expect(screen.queryByTitle('sleep 55')).toBeNull();
  });

  it('never draws one when the rail is merely hidden either', async () => {
    await renderSurface(false);

    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
    expect(screen.queryByText('Background processes')).toBeNull();
    expect(screen.queryByTitle('sleep 55')).toBeNull();
  });

  it('still hands the AGENTS chip to the rail while it is open, and takes it back when it closes', async () => {
    const { showRail } = await renderSurface(false);
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();

    showRail(true);
    await waitFor(() => expect(screen.queryByText(/1 agent/)).toBeNull());

    showRail(false);
    expect(await screen.findByText(/1 agent/)).toBeInTheDocument();
    // The rail closing must not bring the process row back with the chip.
    expect(screen.queryByText('Background processes')).toBeNull();
  });
});
