import { Profiler, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { ChatView } from '../../../modules/chat/ChatView';
import { CardBlock, Message } from '../../../modules/advisor/BrainChatSurface';
import { TelemetryRailProvider } from '../../../modules/advisor/telemetryRailState';
import * as transcript from '../../../lib/transcript';
import * as format from '../../../lib/format';
import * as presentation from '../../../lib/chatPresentation';
import * as scope from '../../../lib/processScope';

/** A long conversation that is still working, modelled on the phone screenshot that reported this:
 *  a deep transcript, a 33-item task card at 25 done, two running sub-agents with elapsed clocks, a
 *  compaction notice, live telemetry and a streaming answer — while the reader types the next message.
 *
 *  What this pins is WORK, not milliseconds. A wall-clock budget on a shared CI box measures the box; the
 *  render counts below are exact. Timings are printed for the record and bounded only in RELATIVE terms
 *  (a long conversation against a short one), which stays meaningful on any host.
 *
 *  Be precise about what changed, because the file it guards is easy to over-claim: settled turn BODIES
 *  were already memoized before this branch. What ran on every single token was the row wrapper for every
 *  turn in the conversation (a component call and a fresh element per row), plus the whole task card and
 *  the elapsed clocks, because the wrapper had to receive the live narration in order to keep it away from
 *  the body. Removing that prop is what lets the row itself be memoized and drop out of the token path;
 *  measured here at 120 turns, React work per token went from 19.4 ms to 11.9 ms and task-card rebuilds
 *  from 21 per 20 tokens to 2.
 *
 *  The probes are functions the render bodies call, so they count renders without instrumenting the
 *  components under test:
 *    - `isBackgroundProcessCardId` — the surface's own card filter      → CHAT SHELL renders
 *    - `localDateTime`  — the timestamp under every settled turn        → settled ROW renders
 *    - `groupToolItems` — the tool-pill grouping in every tool segment  → settled TOOL GROUP renders
 *    - `todoPreviewItems` — the task card's preview window              → TASK CARD renders
 *    - `formatTokens`   — the statusline/telemetry figures              → TELEMETRY renders
 *    - `formatDuration` — every elapsed clock on screen (agent chips,
 *                         reasoning blocks, settled turn durations)     → CLOCK renders
 */

class FakeES {
  static instances: FakeES[] = [];
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

const TASK_CARD = {
  id: 'todo',
  title: 'Úkoly',
  items: Array.from({ length: 33 }, (_, i) => ({
    id: `task-${i}`,
    text: `Task ${i}`,
    status: i < 25 ? 'completed' : i < 27 ? 'in_progress' : 'pending',
    startedAt: i >= 25 && i < 27 ? Date.now() - 3_400_000 : undefined,
  })),
};

/** Two delegated agents still running, with the elapsed clocks the screenshot shows. */
const AGENT_TURN = {
  id: 'agents', role: 'assistant', text: '',
  segments: [{
    kind: 'tool', name: 'Delegate', id: 'dlg-1', detail: 'skills',
    sub: { sessionId: 'sub-1', name: 'Sol řídí pluginové skilly', status: 'running', startedAt: new Date(Date.now() - 3_446_000).toISOString() },
  }, {
    kind: 'tool', name: 'Delegate', id: 'dlg-2', detail: 't/s',
    sub: { sessionId: 'sub-2', name: 'Sol opravuje t/s', status: 'running', startedAt: new Date(Date.now() - 3_161_000).toISOString() },
  }],
};

/** Settled history. Every turn carries a timestamp and a tool group, so a re-render of one is visible. */
const history = (turns: number) => Array.from({ length: turns }, (_, i) => (i % 2 === 0
  ? { id: `h${i}`, role: 'user', text: `Question ${i}`, createdAt: '2026-09-14T09:15:12.000Z' }
  : {
    id: `h${i}`, role: 'assistant', text: '', createdAt: '2026-09-14T09:15:13.000Z', durationMs: 1200,
    segments: [
      { kind: 'text', text: `Answer ${i}, long enough that the row wraps onto a second line on a phone.` },
      { kind: 'tool', name: 'Read', id: `call-${i}`, detail: `file-${i}.ts` },
    ],
  }));

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.post('*/api/brain/send', () => HttpResponse.json({ ok: true }, { status: 202 })),
  http.post('*/api/brain/visibility', () => HttpResponse.json({ ok: true })),
  http.get('*/api/brain/messages', ({ request }) => new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([])),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'gpt-5.6-sol',
    usage: { tokens: 401_000, contextWindow: 1_000_000, percent: 40, totalTokens: 5_195_900_000, cost: 1.2, effectiveTps: 42 },
    statusline: { showModel: true, showContext: true, showTokens: true, showSpeed: true, showCost: true },
    cards: [TASK_CARD], queued: [],
  })),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/processes', () => HttpResponse.json([])),
  http.get('*/api/brain/sessions', () => HttpResponse.json([
    { id: 'brain-1', title: 'Long chat', model: 'gpt-5.6-sol', updated_at: '2026-09-14', running: true, active: true },
  ])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
  http.get('*/api/auth/me', () => HttpResponse.json({ user: { id: 2, username: 'me', is_admin: false } })),
  http.get('*/api/brain/conversation-links', () => HttpResponse.json({ status: 'available', links: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => { server.resetHandlers(); FakeES.instances.length = 0; localStorage.clear(); vi.restoreAllMocks(); });
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

function renderChat(node: ReactNode) {
  const { wrapper: Wrapper } = createWrapper();
  return render(
    <Wrapper><ToastProvider><BrainChatProvider><TelemetryRailProvider>{node}</TelemetryRailProvider></BrainChatProvider></ToastProvider></Wrapper>,
  );
}

interface Probes {
  shell: ReturnType<typeof vi.spyOn>;
  rows: ReturnType<typeof vi.spyOn>;
  toolGroups: ReturnType<typeof vi.spyOn>;
  taskCard: ReturnType<typeof vi.spyOn>;
  telemetry: ReturnType<typeof vi.spyOn>;
  clocks: ReturnType<typeof vi.spyOn>;
}

const probes = (): Probes => ({
  // The surface itself: it filters the cards through this on every render, so with a card on screen the
  // call count IS the number of times the chat shell re-rendered.
  shell: vi.spyOn(scope, 'isBackgroundProcessCardId'),
  rows: vi.spyOn(format, 'localDateTime'),
  toolGroups: vi.spyOn(transcript, 'groupToolItems'),
  taskCard: vi.spyOn(presentation, 'todoPreviewItems'),
  telemetry: vi.spyOn(format, 'formatTokens'),
  clocks: vi.spyOn(format, 'formatDuration'),
});
const clear = (p: Probes) => { for (const spy of Object.values(p)) spy.mockClear(); };
const counts = (p: Probes) => Object.fromEntries(Object.entries(p).map(([k, spy]) => [k, spy.mock.calls.length])) as Record<keyof Probes, number>;

/** Mount the long, busy conversation from the screenshot and return its handles. */
async function openBusyChat(turns: number) {
  const commits: number[] = [];
  renderChat(
    <Profiler id="chat" onRender={(_id, _phase, actualDuration) => commits.push(actualDuration)}>
      <main><ChatView /></main>
    </Profiler>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  const stream = FakeES.instances[0]!;
  stream.emit('snapshot', {
    type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, events: [],
    history: [...history(turns), AGENT_TURN],
    cards: [TASK_CARD],
  });
  stream.emit('card', { card: TASK_CARD });
  stream.emit('notice', { message: 'compacting conversation…' });
  const composer = await screen.findByTestId('chat-composer') as HTMLTextAreaElement;
  // The busy state from the screenshot is really on screen before anything is measured.
  await screen.findByText('compacting conversation…');
  expect(screen.getAllByTestId('chat-turn').length).toBeGreaterThanOrEqual(turns);
  return { stream, composer, commits };
}

/** Type `text` one character at a time, the way a person does. */
function typeInto(composer: HTMLTextAreaElement, text: string): number[] {
  const perKey: number[] = [];
  let typed = '';
  for (const character of text) {
    typed += character;
    const start = performance.now();
    fireEvent.change(composer, { target: { value: typed } });
    perKey.push(performance.now() - start);
  }
  return perKey;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe('a long, still-working conversation', () => {
  it('keeps the transcript row behind a memo boundary', () => {
    // Structural, because it is the thing that is easy to undo by accident: adding one live prop back
    // onto a row (narration, an artifact list, anything that moves with the stream) silently turns every
    // settled turn back into a dependent of the stream, and only a long conversation on a slow phone
    // shows it. `ChatArtifactScope` is the seam that keeps those values off the row's props.
    expect((Message as unknown as { $$typeof: symbol }).$$typeof, 'the transcript row lost its memo boundary')
      .toBe(Symbol.for('react.memo'));
    expect((CardBlock as unknown as { $$typeof: symbol }).$$typeof, 'the task card lost its memo boundary')
      .toBe(Symbol.for('react.memo'));
  });

  it('reconciles only the live turn when a token streams in', async () => {
    const { stream, commits } = await openBusyChat(120);
    const p = probes();
    clear(p);
    commits.length = 0;

    const start = performance.now();
    for (let i = 0; i < 20; i++) stream.emit('text', { delta: 'token ' });
    const elapsed = performance.now() - start;

    const seen = counts(p);
    console.info(`[stream] 20 tokens over 120 settled turns: ${(elapsed / 20).toFixed(2)} ms/token, `
      + `${commits.length} commits, ${(commits.reduce((a, b) => a + b, 0) / 20).toFixed(2)} ms of React work per token, `
      + `probes ${JSON.stringify(seen)}`);

    // A settled turn's content cannot change because a token landed in the LIVE turn. Its row component
    // is memoized (`Message`) and, since the live state moved behind `ChatArtifactScope`, nothing
    // stream-shaped reaches its props any more, so React does not even call it.
    expect(seen.rows, 'a streamed token re-rendered settled transcript rows').toBe(0);
    expect(seen.toolGroups, 'a streamed token re-rendered settled tool groups').toBe(0);
    // Nor is the task card live data: it changes on its own card event, and a token is not one. It keeps
    // a once-a-second clock of its own while a row is running, so the bound here is elapsed time rather
    // than the number of tokens — which is exactly the distinction that matters.
    expect(seen.taskCard, 'a streamed token rebuilt the 33-item task card').toBeLessThanOrEqual(3);
    // One commit per token (the first also clears the compaction notice), never one per subtree.
    expect(commits.length).toBeLessThanOrEqual(21);
    // The live turn IS re-rendered — that is the point of streaming, and the proof the probes above are
    // not simply blind: the growing answer is on screen.
    expect(screen.getByTestId('chat-transcript')).toHaveTextContent('token token');
  });

  it('keeps a keystroke inside the composer while the conversation streams, tasks tick and agents run', async () => {
    const { stream, composer, commits } = await openBusyChat(120);
    const p = probes();

    // A keystroke on its own.
    clear(p);
    commits.length = 0;
    const quiet = typeInto(composer, 'ahoj jak to jde');
    const quietCounts = counts(p);
    console.info(`[quiet] ${quiet.length} keystrokes: ${commits.length} commits, `
      + `median ${median(quiet).toFixed(2)} ms, probes ${JSON.stringify(quietCounts)}`);
    expect(quietCounts.rows, 'a keystroke re-rendered settled transcript rows').toBe(0);
    expect(quietCounts.toolGroups, 'a keystroke re-rendered settled tool groups').toBe(0);
    expect(quietCounts.taskCard, 'a keystroke re-rendered the task card').toBe(0);
    expect(quietCounts.telemetry, 'a keystroke re-rendered the telemetry figures').toBe(0);
    expect(quietCounts.clocks, 'a keystroke re-rendered an elapsed clock').toBe(0);
    expect(quietCounts.shell, 'a keystroke re-rendered the chat shell').toBe(0);
    // One commit per character: the composer subtree and nothing else.
    expect(commits.length).toBe(quiet.length);

    // The same keystrokes with the answer streaming underneath them.
    fireEvent.change(composer, { target: { value: '' } });
    clear(p);
    commits.length = 0;
    const busyPerKey: number[] = [];
    let typed = '';
    for (const character of 'ahoj jak to jde') {
      stream.emit('text', { delta: 'token ' });
      typed += character;
      const start = performance.now();
      fireEvent.change(composer, { target: { value: typed } });
      busyPerKey.push(performance.now() - start);
    }
    expect(composer).toHaveValue(typed);
    const busyCounts = counts(p);
    console.info(`[busy] ${busyPerKey.length} keystrokes interleaved with ${busyPerKey.length} tokens: `
      + `${commits.length} commits, median keystroke ${median(busyPerKey).toFixed(2)} ms `
      + `(quiet ${median(quiet).toFixed(2)} ms), probes ${JSON.stringify(busyCounts)}`);

    // The settled transcript stays untouched by BOTH the keystrokes and the tokens: what the tokens do
    // re-render is the shell (the live figures it holds), once per token, not once per row.
    expect(busyCounts.rows, 'typing while streaming re-rendered settled transcript rows').toBe(0);
    expect(busyCounts.toolGroups, 'typing while streaming re-rendered settled tool groups').toBe(0);
    expect(busyCounts.shell, 'the shell re-rendered more than once per streamed token').toBeLessThanOrEqual(busyPerKey.length);
    // One commit per keystroke plus one per token (plus the notice the first token clears); anything
    // beyond that is a subtree reacting to typing.
    expect(commits.length).toBeLessThanOrEqual(busyPerKey.length * 2 + 1);
  });

  it('does not make a keystroke more expensive as the conversation grows', async () => {
    // A relative budget: the same sentence typed into a 20-turn and a 200-turn conversation. Absolute
    // milliseconds on a shared host measure the host; a keystroke SCALING with the transcript is the
    // defect, and it is what a person feels on a phone.
    const sentence = 'ahoj jak to jde dneska';
    const short = await openBusyChat(20);
    const shortKeys = median(typeInto(short.composer, sentence));
    const shortCommits = short.commits.length;
    cleanup();
    FakeES.instances.length = 0;

    const long = await openBusyChat(200);
    const longCommits = long.commits.length;
    const longKeys = median(typeInto(long.composer, sentence));
    console.info(`[scaling] median keystroke ${shortKeys.toFixed(2)} ms at 20 turns / `
      + `${longKeys.toFixed(2)} ms at 200 turns (mount commits ${shortCommits} / ${longCommits})`);
    // A coarse net, deliberately. Both medians are around a millisecond on a quiet host, where a ratio
    // alone is mostly scheduler noise, so the floor keeps it from failing on nothing; a keystroke that
    // reconciles the whole transcript costs an order of magnitude more than this, not four times.
    expect(longKeys).toBeLessThan(Math.max(shortKeys * 4, 8));
  });
});
