import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatSurface } from '../../../modules/advisor/BrainChatSurface';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';

/** The chat surface's CLI-parity affordances: repeated tool calls fold into one row with a `×N` count,
 *  the still-executing call carries a running indicator, a reasoning segment is a collapsible block with
 *  its elapsed time, and a checklist card previews / collapses and leaves once everything is ticked. */

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

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({ running: false, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [] })),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([{ id: 'brain-1', title: 'Chat', model: 'm', updated_at: '2026-07-08', active: true, attached: 0 }])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderSurface(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider><BrainChatSurface variant="compact" /></BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBeGreaterThan(0));
  return FakeES.instances[0]!;
}

const REASONING = 'weighing the options';

const todoCard = (statuses: ('pending' | 'in_progress' | 'completed')[]) => ({
  id: 'todos',
  title: 'Todos',
  pinned: true,
  items: statuses.map((status, i) => ({ text: `step ${i + 1}`, status })),
});

describe('BrainChatSurface tool rows', () => {
  it('folds a run of identical tool calls into one row with a ×N count', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'Read', id: 't1', detail: 'a.ts' });
      es.emit({ type: 'tool', name: 'Read', id: 't2', detail: 'b.ts' });
      es.emit({ type: 'tool', name: 'Read', id: 't3', detail: 'c.ts' });
    });
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(1));
    expect(screen.getByText('×3')).toBeInTheDocument();
    // The latest call's argument summary wins, exactly as in the CLI.
    expect(screen.getByText('c.ts')).toBeInTheDocument();
  });

  it('keeps tool calls of different tools as separate rows', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'Read', id: 't1', detail: 'a.ts' });
      es.emit({ type: 'tool', name: 'Grep', id: 't2', detail: 'foo' });
    });
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(2));
  });

  it('marks the still-executing tool call as running and clears it when the turn ends', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'tool', name: 'Bash', id: 't1', detail: 'npm test' }));
    expect(await screen.findByRole('status', { name: 'Running' })).toBeInTheDocument();

    act(() => es.emit({ type: 'idle' }));
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Running' })).toBeNull());
  });

  it('does not mark a settled tool call as running', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'Bash', id: 't1', detail: 'npm test' });
      es.emit({ type: 'tool_output', id: 't1', output: { title: 'result', kind: 'result', text: 'ok', tone: 'success' } });
    });
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(1));
    expect(screen.queryByRole('status', { name: 'Running' })).toBeNull();
  });

  it('shows the streamed model reason after the CLI threshold and clears it when the tool starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const es = await renderSurface();
      act(() => es.emit({ type: 'tool_authoring', name: 'Write', detail: '/tmp/readme.md', reason: 'Preparing release…' }));

      await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      expect(screen.getByTestId('chat-tool-authoring')).toHaveTextContent('Preparing release…');
      expect(screen.queryByText('Writing file')).toBeNull();

      act(() => es.emit({ type: 'tool', name: 'Write', id: 't-authoring', detail: '/tmp/readme.md' }));
      await waitFor(() => expect(screen.queryByTestId('chat-tool-authoring')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BrainChatSurface submitted plan', () => {
  it('renders the plan panel from the LIVE tool_end frame (not only after a history reload)', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'p1' });
      // ExitPlanMode's result text is addressed to the model, so the daemon withholds it and the plan
      // rides the settle event instead — the whole live path for a submitted plan.
      es.emit({ type: 'tool_end', id: 'p1', plan: '# Ship it\n\n1. Wire the store' });
    });
    const panel = await screen.findByTestId('chat-plan');
    expect(panel).toHaveTextContent('Ship it');
    expect(panel).toHaveTextContent('Wire the store');
    // The panel REPLACES the tool row — a bare "ExitPlanMode" pill says nothing the panel doesn't.
    expect(screen.queryByTestId('chat-tool-pill')).toBeNull();
  });

  it('renders the plan when a hook-annotated result routes it through tool_output instead', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'ExitPlanMode', id: 'p2' });
      es.emit({
        type: 'tool_output', id: 'p2', plan: '# Migrate the store',
        output: { title: 'ExitPlanMode', kind: 'result', text: 'formatted', tone: 'success' },
      });
    });
    expect(await screen.findByTestId('chat-plan')).toHaveTextContent('Migrate the store');
  });

  it('leaves a plain tool_end as a bare tool row', async () => {
    const es = await renderSurface();
    act(() => {
      es.emit({ type: 'tool', name: 'Read', id: 'r1', detail: 'a.ts' });
      es.emit({ type: 'tool_end', id: 'r1' });
    });
    await waitFor(() => expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(1));
    expect(screen.queryByTestId('chat-plan')).toBeNull();
  });
});

describe('BrainChatSurface reasoning block', () => {
  it('shows the elapsed thinking time while the model reasons', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const es = await renderSurface();
      act(() => es.emit({ type: 'reasoning', delta: REASONING }));
      expect(await screen.findByTestId('chat-thought')).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
      expect(screen.getByTestId('chat-thought')).toHaveTextContent('12s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the reasoning while the model thinks and folds it away once the turn settles', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'reasoning', delta: REASONING }));
    expect(await screen.findByText(REASONING)).toBeInTheDocument();

    act(() => es.emit({ type: 'idle' }));
    await waitFor(() => expect(screen.queryByText(REASONING)).toBeNull());
    // The block itself stays as the fold-open handle — only its body is folded away.
    expect(screen.getByTestId('chat-thought')).toBeInTheDocument();
  });

  it('keeps the block folded once the reader closed it, even as reasoning keeps streaming', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'reasoning', delta: REASONING }));
    const block = await screen.findByTestId('chat-thought');

    fireEvent.click(block.querySelector('button')!);
    act(() => es.emit({ type: 'reasoning', delta: ' and one more' }));
    await waitFor(() => expect(screen.queryByText(new RegExp(REASONING))).toBeNull());
  });
});

describe('BrainChatSurface checklist card', () => {
  it('previews the first four items and reveals the rest on demand', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'card', card: todoCard(['in_progress', 'pending', 'pending', 'pending', 'pending', 'pending']) }));
    expect(await screen.findByText('step 1')).toBeInTheDocument();
    expect(screen.queryByText('step 5')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+2 more' }));
    expect(await screen.findByText('step 6')).toBeInTheDocument();
  });

  it('previews recent progress and the next active work instead of the first four rows', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'card', card: todoCard([
      'completed', 'pending', 'completed', 'completed', 'pending', 'in_progress', 'completed', 'pending',
    ]) }));

    expect(await screen.findByText('step 2')).toBeInTheDocument();
    expect(screen.getByText('step 4')).toBeInTheDocument();
    expect(screen.getByText('step 6')).toBeInTheDocument();
    expect(screen.getByText('step 7')).toBeInTheDocument();
    expect(screen.queryByText('step 1')).toBeNull();
    expect(screen.queryByText('step 3')).toBeNull();
    expect(screen.queryByText('step 5')).toBeNull();
  });

  it('collapses the checklist from its header', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'card', card: todoCard(['in_progress', 'pending']) }));
    const header = await screen.findByRole('button', { name: /Todos/ });
    expect(screen.getByText('step 1')).toBeInTheDocument();

    fireEvent.click(header);
    await waitFor(() => expect(screen.queryByText('step 1')).toBeNull());
  });

  it('drops the checklist once every item is completed', async () => {
    const es = await renderSurface();
    act(() => es.emit({ type: 'card', card: todoCard(['in_progress', 'pending']) }));
    expect(await screen.findByText('step 1')).toBeInTheDocument();

    act(() => es.emit({ type: 'card', card: todoCard(['completed', 'completed']) }));
    await waitFor(() => expect(screen.queryByText('step 1')).toBeNull());
  });
});
