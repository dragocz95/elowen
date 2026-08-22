import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** One visible reply is MANY stored assistant rows — one per tool round — and every row carries its own
 *  `createdAt`. Stamping each of them printed the same date+time above every single tool row. The daemon
 *  marks the run's LAST assistant row alone with `turn_duration_ms` (store/schema.sql), and that is the
 *  marker the CLI gates its settled meta on (src/cli/chat/turnRenderer.ts) — so the stamp must land once,
 *  at the end of the turn, on both surfaces. */

class FakeES {
  static instances: FakeES[] = [];
  static OPEN = 1;
  readyState = 1;
  onerror: (() => void) | null = null;
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

const TOOL_ROUND = (id: string, name: string, detail: string, createdAt: string, durationMs?: number) => ({
  role: 'assistant' as const, id, text: '', createdAt,
  segments: [{ kind: 'tool' as const, name, id: `${id}-call`, detail }],
  ...(durationMs != null ? { durationMs } : {}),
});

// One user message and ONE agent turn spent over four tool rounds. Only the last row closes the turn.
const HISTORY = [
  { role: 'user' as const, id: 'u1', text: 'oprav to' },
  TOOL_ROUND('a1', 'Bash', 'git status', '2026-08-22T09:15:01.000Z'),
  TOOL_ROUND('a2', 'Read', 'registry.json', '2026-08-22T09:15:04.000Z'),
  TOOL_ROUND('a3', 'Edit', 'registry.json', '2026-08-22T09:15:09.000Z'),
  TOOL_ROUND('a4', 'Bash', 'git commit', '2026-08-22T09:15:12.000Z', 31_000),
];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-08-22', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

/** The transcript hydrates from the stream's snapshot frame, so the settled turn arrives there. */
async function renderSurface(): Promise<{ container: HTMLElement }> {
  const { wrapper: Wrapper } = createWrapper();
  const { container } = render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="full" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  FakeES.instances[0]!.emit('snapshot', { history: HISTORY, events: [] });
  await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(4));
  return { container };
}

describe('settled turn metadata', () => {
  it('stamps a multi-tool turn exactly once, on its closing row', async () => {
    // Every tool round really is on screen — otherwise "one stamp" would be trivially true.
    await renderSurface();

    const metas = screen.getAllByTestId('chat-turn-meta');
    expect(metas).toHaveLength(1);

    const turns = screen.getAllByTestId('chat-turn');
    expect(turns.at(-1)!.contains(metas[0]!)).toBe(true);
    expect(metas[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-22T09:15:12.000Z');
  });

  it('leaves the intermediate tool rounds unstamped', async () => {
    const { container } = await renderSurface();
    // The <time> element is the timestamp itself: one per visible turn, not one per tool round.
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });
});
