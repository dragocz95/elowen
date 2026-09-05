import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { en } from '../../../lib/i18n/dictionaries/en';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatSurface, Message } from '../../../modules/advisor/BrainChatSurface';
import type { BrainInlineArtifact } from '../../../lib/types';
import { BrainChatProvider, useBrainChat } from '../../../modules/advisor/BrainChatProvider';
import * as transcript from '../../../lib/transcript';
import { useState } from 'react';

/** Guards the two render paths added when the web transcript reached parity with the daemon wire contract:
 *  a session-change EVENT row and a tool-output NOTES suffix. Both are new branches in BrainChatSurface's
 *  Message component — the build only type-checks them; this mounts the real surface over seeded history so
 *  a runtime render crash (or a dropped row) fails CI, which is the closest thing to an E2E of the dock. */

class FakeES {
  static instances: FakeES[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) { FakeES.instances.push(this); }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {}
  emit(type: string, data: unknown) {
    act(() => { for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) }); });
  }
}

// A history page carrying every new-parity row: a model-switch event marker, then an assistant turn whose
// tool output has hook-appended notes.
const HISTORY = [
  { id: 'e1', role: 'event', text: '', kind: 'model', detail: 'gpt-5.4' },
  {
    id: 'm1', role: 'assistant', text: '',
    segments: [{
      kind: 'tool', name: 'Edit', id: 'c1', detail: 'a.ts',
      output: { title: 'result', kind: 'result', text: 'patched', tone: 'success', notes: ['formatted a.ts with prettier'] },
    }],
  },
];

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: HISTORY, hasMore: false, nextBefore: null })
    : HttpResponse.json(HISTORY)),
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

describe('BrainChatSurface renders the daemon-parity rows without crashing', () => {
  it('does not invalidate a message when another turn receives an artifact', () => {
    const turn: transcript.ChatTurn = { id: 'settled', role: 'elowen', streaming: false,
      segments: [{ kind: 'tools', items: [{ id: 'old-call', name: 'Read' }] }] };
    const artifact: BrainInlineArtifact = { id: 'view', plugin: 'test', sessionId: 'brain-1',
      toolCallId: 'other-call', view: 'test', fallback: 'Artifact', status: 'open',
      expiresAt: '', createdAt: '', updatedAt: '' };
    function Harness() {
      const [artifacts, setArtifacts] = useState<BrainInlineArtifact[]>([]);
      return <><button onClick={() => setArtifacts([artifact])}>Update artifact</button>
        <Message turn={turn} artifacts={artifacts} narration={artifacts.length ? 'new narration' : undefined} showThoughts /></>;
    }
    const group = vi.spyOn(transcript, 'groupToolItems');
    try {
      const { wrapper } = createWrapper();
      render(<Harness />, { wrapper });
      group.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Update artifact' }));
      expect(group.mock.calls.length).toBe(0);
    } finally { group.mockRestore(); }
  });

  it('shares the draft across surfaces, retains it across remounts and submits the latest text', async () => {
    const sent = vi.fn();
    server.use(http.post('*/api/brain/send', async ({ request }) => {
      sent(await request.json());
      return HttpResponse.json({ ok: true, accepted: true }, { status: 202 });
    }));
    function Surfaces() {
      const [full, setFull] = useState(true);
      return <><button onClick={() => setFull((value) => !value)}>Toggle surface</button>
        {full ? <BrainChatSurface variant="full" /> : null}<BrainChatSurface /></>;
    }
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><Surfaces /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const editors = screen.getAllByTestId('chat-composer');
    fireEvent.change(editors[0]!, { target: { value: 'shared draft' } });
    expect(editors[1]).toHaveValue('shared draft');
    fireEvent.click(screen.getByText('Toggle surface'));
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: 'latest draft' } });
    fireEvent.click(screen.getByText('Toggle surface'));
    for (const editor of screen.getAllByTestId('chat-composer')) expect(editor).toHaveValue('latest draft');
    fireEvent.keyDown(screen.getAllByTestId('chat-composer')[0]!, { key: 'Enter' });
    await waitFor(() => expect(sent).toHaveBeenCalledWith(expect.objectContaining({ text: 'latest draft' })));
    for (const editor of screen.getAllByTestId('chat-composer')) expect(editor).toHaveValue('');
  });

  it('does not rewrite unchanged composer height on appended characters', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const composer = screen.getByTestId('chat-composer');
    const observer = new MutationObserver(() => {});
    observer.observe(composer, { attributes: true, attributeFilter: ['style'] });
    try {
      fireEvent.change(composer, { target: { value: 'a' } });
      expect(observer.takeRecords()).toHaveLength(0);
    } finally { observer.disconnect(); }
  });

  it('does not broadcast typing to non-editor chat consumers', async () => {
    const rendered = vi.fn();
    function Observer() { useBrainChat(); rendered(); return null; }
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><Observer /><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    rendered.mockClear();
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: 'unsent text' } });
    expect(screen.getByTestId('chat-composer')).toHaveValue('unsent text');
    expect(rendered.mock.calls.length).toBe(0);
  });

  it('does not regroup settled tool history on live text updates', async () => {
    const history = Array.from({ length: 300 }, (_, i) => ({
      id: `history-${i}`, role: 'assistant', text: '',
      segments: [{ kind: 'tool', name: 'Read', id: `call-${i}`, detail: `file-${i}.ts` }],
    }));
    const group = vi.spyOn(transcript, 'groupToolItems');
    try {
      const { wrapper: Wrapper } = createWrapper();
      render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
      await waitFor(() => expect(FakeES.instances.length).toBe(1));
      const stream = FakeES.instances[0]!;
      stream.emit('snapshot', { history, events: [], hasMore: false, nextBefore: null });
      expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(300);
      group.mockClear();
      const start = performance.now();
      for (let i = 0; i < 20; i++) stream.emit('text', { delta: ' live' });
      console.info(`history stream: ${group.mock.calls.length} regroupings, ${(performance.now() - start).toFixed(1)}ms`);
      expect(screen.getAllByTestId('chat-tool-pill')).toHaveLength(300);
      expect(group.mock.calls.length).toBe(0);
      stream.emit('tool', { name: 'Bash', id: 'live-tool' });
      group.mockClear();
      for (let i = 0; i < 5; i++) stream.emit('tool_progress', { id: 'live-tool', text: `progress ${i}` });
      expect(group.mock.calls.every(([items]) => items.every((item) => item.id === 'live-tool'))).toBe(true);
      expect(screen.getByText('progress 4')).toBeInTheDocument();
      group.mockClear();
      fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: 'next question' } });
      expect(group.mock.calls.length).toBe(0);
    } finally { group.mockRestore(); }
  });
  it('shows a session-change event marker and a tool-output notes suffix from seeded history', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    // The transcript is hydrated by the stream's snapshot frame, not by a separate history fetch.
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', history: HISTORY, events: [], hasMore: false, nextBefore: null,
    });
    // The event row renders its label (eventLabel mirror of the daemon sessionEventLabel).
    expect(await screen.findByText('model → gpt-5.4')).toBeInTheDocument();
    // The tool-output notes suffix renders under the output body.
    expect(await screen.findByText(/formatted a\.ts with prettier/)).toBeInTheDocument();
  });

  it('renders a sub-agent finish marker parsed from its JSON detail', async () => {
    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    const detail = JSON.stringify({ session: 'brain-ch-subagent-sub-dlg-abc', task: 'Explore the repo', status: 'done' });
    const [es] = FakeES.instances;
    es?.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1',
      history: [{ id: 's-evt', role: 'event', text: '', kind: 'subagent', detail }],
      events: [], hasMore: false, nextBefore: null,
    });
    // The label parses the JSON detail; the "sub-agent" prefix is shared across cs/en, so this asserts the
    // parse + label without pinning the test to a locale.
    expect(await screen.findByText(/sub-agent.*· Explore the repo/)).toBeInTheDocument();
  });

  it('lets the user expand a truncated tool output instead of promising a broken terminal link', async () => {
    // Regression for review-web-sol finding 6: the old markup rendered "Click to expand in terminal" on a
    // plain div with no handler. This asserts the affordance is now a real, working, translated toggle.
    const richHistory = [{
      id: 'm2', role: 'assistant', text: '',
      segments: [{
        kind: 'tool', name: 'Bash', id: 'c2', detail: 'npm test',
        output: { title: 'result', kind: 'console', text: 'FAIL summary', fullText: 'FAIL summary\nfull failure log here' },
      }],
    }];
    server.use(http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
      ? HttpResponse.json({ items: richHistory, hasMore: false, nextBefore: null })
      : HttpResponse.json(richHistory)));

    const { wrapper: Wrapper } = createWrapper();
    render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
    await waitFor(() => expect(FakeES.instances.length).toBe(1));
    FakeES.instances[0]!.emit('snapshot', {
      type: 'snapshot', sessionId: 'brain-1', history: richHistory, events: [], hasMore: false, nextBefore: null,
    });

    const expandBtn = await screen.findByTestId('chat-tool-output-expand');
    expect(expandBtn).toHaveTextContent(en.brainChat.toolOutputExpand);
    expect(screen.queryByText(/full failure log here/)).toBeNull();

    fireEvent.click(expandBtn);
    expect(await screen.findByText(/full failure log here/)).toBeInTheDocument();
    expect(expandBtn).toHaveTextContent(en.brainChat.toolOutputCollapse);

    fireEvent.click(expandBtn); // toggles back to the short preview
    await waitFor(() => expect(screen.queryByText(/full failure log here/)).toBeNull());
  });
});
