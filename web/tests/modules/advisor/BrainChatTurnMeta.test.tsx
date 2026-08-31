import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
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

const TOOL_ROUND = (id: string, name: string, detail: string, createdAt: string, durationMs?: number, model?: string) => ({
  role: 'assistant' as const, id, text: '', createdAt,
  segments: [{ kind: 'tool' as const, name, id: `${id}-call`, detail }],
  ...(durationMs != null ? { durationMs } : {}),
  ...(model ? { model } : {}),
});

// One user message and ONE agent turn spent over four tool rounds. Only the last row closes the turn.
const HISTORY = [
  { role: 'user' as const, id: 'u1', text: 'oprav to' },
  TOOL_ROUND('a1', 'Bash', 'git status', '2026-08-22T09:15:01.000Z'),
  TOOL_ROUND('a2', 'Read', 'registry.json', '2026-08-22T09:15:04.000Z'),
  TOOL_ROUND('a3', 'Edit', 'registry.json', '2026-08-22T09:15:09.000Z'),
  TOOL_ROUND('a4', 'Bash', 'git commit', '2026-08-22T09:15:12.000Z', 31_000, 'claude-opus-5'),
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
async function renderSurface(history: readonly unknown[] = HISTORY, variant: 'full' | 'compact' = 'full'): Promise<{ container: HTMLElement; stream: FakeES }> {
  const { wrapper: Wrapper } = createWrapper();
  const { container } = render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant={variant} /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  const stream = FakeES.instances[0]!;
  stream.emit('snapshot', { history, events: [] });
  return { container, stream };
}

describe('settled turn metadata', () => {
  it('stamps a multi-tool turn exactly once, on its closing row', async () => {
    // Every tool round really is on screen — otherwise "one stamp" would be trivially true.
    await renderSurface();
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(4));

    // HISTORY's user row predates the timestamp column, so the agent turn owns the only stamp here.
    const metas = screen.getAllByTestId('chat-turn-meta');
    expect(metas).toHaveLength(1);
    expect(metas[0]).toHaveClass('text-caption', 'text-muted-foreground');
    expect(metas[0]?.className).not.toContain('text-muted-foreground/');

    const turns = screen.getAllByTestId('chat-turn');
    expect(turns.at(-1)!.contains(metas[0]!)).toBe(true);
    expect(metas[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-22T09:15:12.000Z');
    const model = screen.getByTestId('chat-turn-model');
    expect(model).toHaveTextContent('claude-opus-5');
    expect(model.querySelector('img, svg')).not.toBeNull();
  });

  it('leaves the intermediate tool rounds unstamped', async () => {
    const { container } = await renderSurface();
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(4));
    // The <time> element is the timestamp itself: one per visible turn, not one per tool round.
    expect(container.querySelectorAll('time')).toHaveLength(1);
  });
});

/** A sent message is a turn of its own and carries its own stamp. The whole chain used to drop it — the
 *  daemon's user view, the live `user` frame, the stream handler's cast, the provider's destructure and the
 *  transcript fold — so the chat could only ever date the agent's replies, never the user's own messages. */
describe('sent message metadata', () => {
  it.each(['full', 'compact'] as const)('keeps user metadata inside the %s bubble and assistant metadata outside its body', async (variant) => {
    await renderSurface([
      { role: 'user', id: 'u1', text: 'oprav to', createdAt: '2026-08-22T09:14:58.000Z' },
      TOOL_ROUND('a1', 'Bash', 'git commit', '2026-08-22T09:15:12.000Z', 31_000, 'claude-opus-5'),
    ], variant);
    await waitFor(() => expect(screen.getAllByTestId('chat-turn-meta')).toHaveLength(2));

    const userTurn = screen.getAllByTestId('chat-turn').find((turn) => turn.getAttribute('data-role') === 'you')!;
    const userBubble = within(userTurn).getByTestId('chat-user-bubble');
    const userMeta = within(userTurn).getByTestId('chat-turn-meta');
    expect(userBubble).toContainElement(userMeta);
    expect(userMeta).toHaveAttribute('data-role', 'user');
    expect(userMeta.querySelector('time')).toHaveAttribute('datetime', '2026-08-22T09:14:58.000Z');

    const assistantTurn = screen.getAllByTestId('chat-turn').find((turn) => turn.getAttribute('data-role') === 'assistant')!;
    const assistantBody = within(assistantTurn).getByTestId('chat-assistant-body');
    const assistantMeta = within(assistantTurn).getByTestId('chat-turn-meta');
    expect(assistantBody).not.toContainElement(assistantMeta);
    expect(assistantMeta).toHaveAttribute('data-role', 'assistant');
    expect(within(assistantMeta).getByTestId('chat-turn-model')).toHaveTextContent('claude-opus-5');
  });

  it('stamps the user bubble from the row the message was stored with', async () => {
    const { container } = await renderSurface([
      { role: 'user', id: 'u1', text: 'oprav to', createdAt: '2026-08-22T09:14:58.000Z' },
      TOOL_ROUND('a1', 'Bash', 'git commit', '2026-08-22T09:15:12.000Z', 31_000),
    ]);
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(1));

    expect([...container.querySelectorAll('time')].map((el) => el.getAttribute('datetime')))
      .toEqual(['2026-08-22T09:14:58.000Z', '2026-08-22T09:15:12.000Z']);
  });

  it('stamps the live bubble with the exact time the reload path will serve', async () => {
    // The daemon reads `createdAt` back off the durable row it just wrote rather than stamping a second
    // clock, so refreshing must not move the time under a message the user is still looking at.
    const { container, stream } = await renderSurface([]);
    stream.emit('user', { text: 'zkus to znovu', durableId: 'u9', createdAt: '2026-08-22 09:20:41' });

    await waitFor(() => screen.getByText('zkus to znovu'));
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-22 09:20:41');
  });
});
