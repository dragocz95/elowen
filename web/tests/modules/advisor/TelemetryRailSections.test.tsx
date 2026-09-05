import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { onUnhandledRequest } from '../../msw';
import { createWrapper } from '../../test-utils';
import { ToastProvider } from '../../../components/ui/Toast';
import { BrainChat } from '../../../modules/advisor/BrainChat';
import { BrainChatProvider } from '../../../modules/advisor/BrainChatProvider';
import { TelemetryPanel } from '../../../modules/advisor/TelemetryPanel';
import type { ProcessInfo } from '../../../lib/types';

// The rail is the web's answer to the CLI telemetry panel: what runs RIGHT NOW (goal, workflows,
// sub-agents, background processes) must be visible without opening the transcript, and it must survive
// a reconnect — a phone that slept and woke up gets a fresh snapshot, never the events it missed.

/** EventSource stand-in that can deliver frames to the registered listeners. */
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
}

const process1: ProcessInfo = {
  id: 'p1', command: 'npm run dev', cwd: '/var/www/elowen', sessionId: 'brain-1', startedAt: '2026-07-27T10:00:00.000Z',
  running: true, exitCode: null, completionMode: 'service',
};

let processes: ProcessInfo[] = [];
/** How many times the rail's process list was actually served — asserting that a row is ABSENT is only
 *  meaningful once the data it would have come from has arrived. */
let processFetches = 0;
/** Ids the rail asked the daemon to kill — the "other processes" section is the only web view that can. */
const killed: string[] = [];

const activeGoal = {
  session_id: 'brain-1', user_id: 1, status: 'active' as const,
  goal: 'Dokončit telemetrický rail', draft: '', subgoals: '[{"text":"a","done":true},{"text":"b"}]',
  turns_used: 3, turn_budget: 20, last_verdict: '', last_evidence: '', paused_reason: '',
  created_at: '2026-07-27 10:00:00', updated_at: '2026-07-27 10:05:00',
};

const server = setupServer(
  http.post('*/api/brain/start', () => HttpResponse.json({ sessionId: 'brain-1' }, { status: 201 })),
  http.get('*/api/brain/messages', ({ request }) => (new URL(request.url).searchParams.has('limit')
    ? HttpResponse.json({ items: [], hasMore: false, nextBefore: null })
    : HttpResponse.json([]))),
  http.get('*/api/brain/status', () => HttpResponse.json({
    running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
  })),
  http.get('*/api/brain/processes', () => { processFetches += 1; return HttpResponse.json(processes); }),
  http.get('*/api/brain/processes/:id/output', () => HttpResponse.json({ output: 'ready on :4500' })),
  http.delete('*/api/brain/processes/:id', ({ params }) => { killed.push(String(params['id'])); return HttpResponse.json({ killed: true }); }),
  http.get('*/api/brain/rate-limits/all', () => HttpResponse.json({})),
  http.get('*/api/brain/sessions', () => HttpResponse.json([])),
  http.get('*/api/brain/commands', () => HttpResponse.json({ commands: [] })),
);

beforeAll(() => {
  server.listen({ onUnhandledRequest });
  (Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {};
});
afterEach(() => {
  server.resetHandlers();
  FakeES.instances.length = 0;
  processes = [];
  processFetches = 0;
  killed.length = 0;
  localStorage.clear();
  vi.restoreAllMocks();
});
afterAll(() => server.close());
beforeEach(() => { (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES; });

async function renderRail(onOpenWorkflow?: (id: string) => void): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(
    <Wrapper><ToastProvider><BrainChatProvider>
      <BrainChat />
      <TelemetryPanel variant="column" onOpenWorkflow={onOpenWorkflow} />
    </BrainChatProvider></ToastProvider></Wrapper>,
  );
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

async function renderChatOnly(): Promise<FakeES> {
  const { wrapper: Wrapper } = createWrapper();
  render(<Wrapper><ToastProvider><BrainChatProvider><BrainChat /></BrainChatProvider></ToastProvider></Wrapper>);
  await waitFor(() => expect(FakeES.instances.length).toBe(1));
  return FakeES.instances[0]!;
}

const snapshot = (over: Record<string, unknown>) => ({
  type: 'snapshot', sessionId: 'brain-1', hasMore: false, nextBefore: null, history: [], events: [],
  control: { streaming: false, pendingAsk: null }, ...over,
});

/** A delegate tool call plus its sub-agent progress — the shape the rail's agent rows are folded from. */
const subagentEvents = (over: {
  sessionId: string; status: 'running' | 'done'; task: string; id: string;
  detail?: string; model?: string; tokens?: number; thinkingLabel?: string;
  background?: boolean; autoDeliver?: boolean; resultDelivery?: 'pending' | 'acknowledged';
  tools?: number; seconds?: number; workspaceId?: string;
}) => ([
  { type: 'tool', name: 'Delegate', id: over.id },
  { type: 'subagent', tools: 1, seconds: 2, ...over },
]);

const workflowEvents = (status: 'running' | 'done', workspaceRef?: { workspaceId: string; projectId: number }) => ([
  { type: 'tool', name: 'WorkflowStart', id: 'w-call' },
  {
    type: 'workflow', id: 'wf-1', toolCallId: 'w-call', title: 'Rail parity', status,
    ...(workspaceRef ? { workspaceRef } : {}),
    nodes: [
      { id: 'a', task: 'prozkoumat', status: 'done', deps: [] },
      { id: 'b', task: 'napsat', status: 'running', deps: ['a'] },
      { id: 'c', task: 'ověřit', status: 'pending', deps: ['b'] },
    ],
  },
]);

describe('telemetry rail — live work sections', () => {
  it('lists a running background process and drops the section when the last one exits', async () => {
    processes = [process1];
    const es = await renderRail();
    const section = await screen.findByTestId('telemetry-processes');
    expect(section.textContent).toContain('npm run dev');

    es.emit('process', { processes: [] });
    await waitFor(() => expect(screen.queryByTestId('telemetry-processes')).toBeNull());
  });

  it('shows processes that were already running before this client connected', async () => {
    // The reconnect case: a woken phone gets no `process` event for work that started while it slept.
    processes = [process1];
    await renderRail();
    const section = await screen.findByTestId('telemetry-processes');
    expect(section.textContent).toContain('npm run dev');
  });

  it('leaves out exited processes and undetached foreground calls', async () => {
    processes = [
      { ...process1, id: 'p2', command: 'npm test', running: false, exitCode: 0, completionMode: 'job' },
      { ...process1, id: 'p3', command: 'grep -r needle', completionMode: 'foreground' },
    ];
    await renderRail();
    await waitFor(() => expect(processFetches).toBeGreaterThan(0));
    expect(screen.queryByTestId('telemetry-processes')).toBeNull();
  });

  it('keeps another conversation job out of the live section, but reachable in the one below', async () => {
    // The processes query is owner-wide, so a job from a different chat comes back too. It is not THIS
    // conversation's live work — yet hiding it outright stranded it: the rail was the only place able to
    // reach a service an orphaned delegate left running. It goes into its own section, not nowhere.
    processes = [
      process1,
      { ...process1, id: 'pX', command: 'python other.py', sessionId: 'brain-99' },
    ];
    await renderRail();
    const section = await screen.findByTestId('telemetry-processes');
    expect(section.textContent).toContain('npm run dev');
    expect(section.textContent).not.toContain('python other.py');

    const other = await screen.findByTestId('telemetry-processes-other');
    expect(other.textContent).toContain('python other.py');
    expect(other.textContent).not.toContain('npm run dev');
  });

  it('confirms a stranded process kill with its command and origin before sending DELETE', async () => {
    let resolveKill!: () => void;
    const killGate = new Promise<void>((resolve) => { resolveKill = resolve; });
    processes = [{ ...process1, id: 'pX', command: 'python {origin}.py', sessionId: 'brain-ch-subagent-sub-dlg-9' }];
    server.use(http.delete('*/api/brain/processes/pX', async () => {
      killed.push('pX');
      await killGate;
      return HttpResponse.json({ killed: true });
    }));
    await renderRail();
    const other = await screen.findByTestId('telemetry-processes-other');
    // The row names where it came from, so the reader knows what they are about to kill.
    expect(other.textContent).toContain('sub-agent');

    await act(async () => { fireEvent.click(within(other).getByRole('button', { name: 'Kill process' })); });
    const confirm = await screen.findByRole('alertdialog', { name: 'Kill this process?' });
    expect(confirm).toHaveTextContent('Command: python {origin}.py');
    expect(confirm).toHaveTextContent('Origin: sub-agent');
    expect(killed).toEqual([]);

    const kill = within(confirm).getByRole('button', { name: 'Kill process' });
    fireEvent.click(kill);
    fireEvent.click(kill);
    await waitFor(() => expect(killed).toEqual(['pX']));
    expect(confirm).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(confirm).toBeInTheDocument();

    resolveKill();
    expect(await screen.findByText('The process was killed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alertdialog', { name: 'Kill this process?' })).toBeNull());
    expect(killed).toEqual(['pX']);
  });

  it('shows a kill error when the daemon rejects the request', async () => {
    processes = [{ ...process1, id: 'pX', command: 'python other.py', sessionId: 'brain-99' }];
    server.use(http.delete('*/api/brain/processes/pX', () => HttpResponse.json({ error: 'failed' }, { status: 500 })));
    await renderRail();
    const other = await screen.findByTestId('telemetry-processes-other');

    fireEvent.click(within(other).getByRole('button', { name: 'Kill process' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Kill this process?' });
    expect(killed).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Kill process' }));

    expect(await screen.findByText('The process could not be killed.')).toBeInTheDocument();
    expect(confirm).toBeInTheDocument();
  });

  it("counts a job started by this conversation's own sub-agent as its live work", async () => {
    processes = [{ ...process1, id: 'pSub', command: 'npm run watch', sessionId: 'child-1' }];
    const es = await renderRail();
    es.emit('snapshot', snapshot({
      events: subagentEvents({ id: 't1', sessionId: 'child-1', status: 'running', task: 'staví web' }),
    }));

    // The delegate runs under its own session id, but the job it started is this conversation's work —
    // so it belongs in the live section, and nothing is left over for the "other" one.
    const section = await screen.findByTestId('telemetry-processes');
    await waitFor(() => expect(section.textContent).toContain('npm run watch'));
    expect(screen.queryByTestId('telemetry-processes-other')).toBeNull();
  });

  it('opens the existing process output modal from a rail row', async () => {
    processes = [process1];
    await renderRail();
    const section = await screen.findByTestId('telemetry-processes');
    const row = within(section).getAllByTestId('telemetry-row')[0]!;
    expect(row).not.toBeNull();
    await act(async () => { fireEvent.click(row!); });
    await screen.findByText('ready on :4500');
  });

  it('shows the active goal in the compact chat without requiring the telemetry rail', async () => {
    const es = await renderChatOnly();
    es.emit('goal', { goal: activeGoal });
    const status = await screen.findByTestId('chat-goal-status');
    expect(status.textContent).toContain('Dokončit telemetrický rail');
    expect(status.textContent).toContain('3/20');
  });

  it('isolates the compact goal status when the stream switches conversations', async () => {
    const es = await renderChatOnly();
    es.emit('goal', { goal: activeGoal });
    await screen.findByTestId('chat-goal-status');

    es.emit('session', { sessionId: 'brain-2' });
    await waitFor(() => expect(screen.queryByTestId('chat-goal-status')).toBeNull());

    es.emit('snapshot', snapshot({
      sessionId: 'brain-2',
      goal: { ...activeGoal, session_id: 'brain-2', goal: 'Goal druhé konverzace', turns_used: 1 },
    }));
    expect(await screen.findByText('Goal druhé konverzace')).toBeInTheDocument();
  });

  it('shows the active goal and hides the section once it is cleared', async () => {
    const es = await renderRail();
    es.emit('goal', { goal: activeGoal });
    const section = await screen.findByTestId('telemetry-goal');
    expect(section.textContent).toContain('Dokončit telemetrický rail');
    expect(section.textContent).toContain('3/20');

    es.emit('goal', { goal: null });
    await waitFor(() => expect(screen.queryByTestId('telemetry-goal')).toBeNull());
  });

  it('hydrates the goal from the reconnect snapshot', async () => {
    const es = await renderRail();
    es.emit('snapshot', snapshot({ goal: activeGoal }));
    const section = await screen.findByTestId('telemetry-goal');
    expect(section.textContent).toContain('Dokončit telemetrický rail');
  });

  it('clears a goal the reconnect snapshot no longer reports', async () => {
    const es = await renderRail();
    es.emit('goal', { goal: activeGoal });
    await screen.findByTestId('telemetry-goal');
    es.emit('snapshot', snapshot({ goal: null }));
    await waitFor(() => expect(screen.queryByTestId('telemetry-goal')).toBeNull());
  });

  it('lists a running workflow with its node tally and opens it on click', async () => {
    const onOpen = vi.fn();
    const es = await renderRail(onOpen);
    for (const event of workflowEvents('running')) es.emit(event.type, event);
    const section = await screen.findByTestId('telemetry-workflow');
    expect(section.textContent).toContain('Rail parity');
    expect(section.textContent).toContain('1/3');

    await act(async () => { fireEvent.click(within(section).getAllByTestId('telemetry-row')[0]!); });
    expect(onOpen).toHaveBeenCalledWith('wf-1');
  });

  it('restores a running workflow from the reconnect snapshot tail', async () => {
    const es = await renderRail();
    es.emit('snapshot', snapshot({ events: workflowEvents('running') }));
    const section = await screen.findByTestId('telemetry-workflow');
    expect(section.textContent).toContain('Rail parity');
  });

  it('hides the workflow section once the DAG finishes', async () => {
    const es = await renderRail();
    for (const event of workflowEvents('running')) es.emit(event.type, event);
    await screen.findByTestId('telemetry-workflow');
    for (const event of workflowEvents('done')) es.emit(event.type, event);
    await waitFor(() => expect(screen.queryByTestId('telemetry-workflow')).toBeNull());
  });

  it('lists only running sub-agents and opens the accessible agents table with working row drill-in', async () => {
    const es = await renderRail();
    es.emit('snapshot', snapshot({
      events: [
        ...subagentEvents({
          id: 't1', sessionId: 'child-1', status: 'running', task: 'hledá volající',
          detail: 'Reads direct callers', model: 'anthropic/sonnet', tokens: 1234,
          thinkingLabel: 'High', tools: 4, seconds: 12, background: true,
          autoDeliver: true, resultDelivery: 'pending',
        }),
        ...subagentEvents({ id: 't2', sessionId: 'child-2', status: 'done', task: 'hotová práce', tools: 2, seconds: 7 }),
      ],
    }));
    const section = await screen.findByTestId('telemetry-agents');
    expect(section.textContent).toContain('Reads direct callers');
    expect(section.textContent).not.toContain('hotová práce');

    await act(async () => { fireEvent.click(within(section).getByTestId('telemetry-row')); });
    const dialog = await screen.findByRole('dialog', { name: 'Agents' });
    const table = within(dialog).getByRole('table', { name: 'Delegated sub-agents' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    for (const value of ['hledá volající', 'Reads direct callers', 'anthropic/sonnet', 'High', '1.2k', '12s', 'Automatic delivery', 'Delivery pending', 'hotová práce']) {
      expect(within(table).getByText(value)).toBeInTheDocument();
    }

    fireEvent.click(within(table).getByRole('button', { name: 'Open sub-agent transcript: hotová práce' }));
    await waitFor(() => expect(FakeES.instances).toHaveLength(2));
    expect(new URL(FakeES.instances[1]!.url, 'http://localhost').searchParams.get('session')).toBe('child-2');
    expect(screen.queryByRole('dialog', { name: 'Agents' })).not.toBeInTheDocument();
  });

  it('marks a sandbox-scoped sub-agent with the workspace icon on the rail and in the agents table', async () => {
    const es = await renderRail();
    es.emit('snapshot', snapshot({
      events: [
        ...subagentEvents({ id: 't1', sessionId: 'child-1', status: 'running', task: 'staví v sandboxu', workspaceId: 'ws_abc123' }),
        ...subagentEvents({ id: 't2', sessionId: 'child-2', status: 'running', task: 'bez sandboxu' }),
      ],
    }));
    const section = await screen.findByTestId('telemetry-agents');
    expect(within(section).getAllByTitle('Running in an isolated sandbox')).toHaveLength(1);
    const sandboxedRow = within(section).getByTitle('Running in an isolated sandbox').closest('li');
    expect(sandboxedRow).not.toBeNull();

    await act(async () => { fireEvent.click(within(sandboxedRow as HTMLElement).getByRole('button')); });
    const dialog = await screen.findByRole('dialog', { name: 'Agents' });
    // Same signal in the drill-in table: exactly the sandboxed row gets the icon, the plain one does not.
    expect(within(dialog).getAllByTitle('Running in an isolated sandbox')).toHaveLength(1);
  });

  it('marks a sandbox-scoped workflow with the workspace icon on the rail', async () => {
    const es = await renderRail();
    for (const event of workflowEvents('running', { workspaceId: 'ws_abc123', projectId: 1 })) es.emit(event.type, event);
    const section = await screen.findByTestId('telemetry-workflow');
    expect(within(section).getByTitle('Running in an isolated sandbox')).toBeInTheDocument();
  });

  // The rail is dragged between 240px and 560px on desktop and pinned to the phone's width in the drawer,
  // so nothing in it may assume a width. Whenever a row could not shrink to the current one — a branch
  // name, a heading, a process command beside its fixed-size icon — the rail answered with a horizontal
  // scrollbar instead of truncating, because a scroll box that declares only `overflow-y` promotes the
  // other axis from `visible` to `auto`. Adding a sub-agent was the usual trigger: the section it brought
  // in made the rail scroll vertically, and that bar took the last pixels the rows had.
  const classesOf = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean);
  const LONG_BRANCH = 'agent/chat-rail-no-scroll-20260818-a-branch-nobody-would-ever-shorten';
  const LONG_COMMAND = 'npm run dev -- --host 0.0.0.0 --port 4500 --project /var/www/elowen/web --verbose';

  it('truncates a long branch name instead of letting it set the section width', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
      project: { cwd: '/var/www/elowen', branch: LONG_BRANCH },
    })));
    await renderRail();
    const section = await screen.findByTestId('telemetry-project');
    // A branch name is one unbreakable token, so without a truncation of its own it has no smaller width.
    expect(classesOf(within(section).getByTitle(LONG_BRANCH))).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });

  // A conversation bound to a Sandbox workspace runs every shell command in that worktree's container, so
  // the foot has to say so beside the directory — and explain, behind the shared help affordance, what
  // that changes and how to leave. Nothing is shown when no workspace is bound.
  it('shows a Sandbox badge with the workspace label when the daemon reports a bound workspace', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
      project: {
        cwd: '/data/sandbox/users/1/workspaces/lease-fixes', branch: 'elowen/u1/lease-fixes',
        workspace: { workspaceId: 'ws_1', label: 'lease-fixes', branch: 'elowen/u1/lease-fixes', confined: true },
      },
    })));
    await renderRail();
    const badge = await screen.findByTestId('telemetry-workspace');
    expect(badge.textContent).toContain('Sandbox');
    expect(badge.textContent).toContain('lease-fixes');
    expect(within(badge).getByRole('button', { name: 'Help' })).toBeInTheDocument();
  });

  it('shows no Sandbox badge for a conversation with no bound workspace', async () => {
    server.use(http.get('*/api/brain/status', () => HttpResponse.json({
      running: true, sessionId: 'brain-1', model: 'm', usage: null, statusline: null, cards: [], queued: [],
      project: { cwd: '/var/www/elowen', branch: 'main', workspace: null },
    })));
    await renderRail();
    await screen.findByTestId('telemetry-project');
    expect(screen.queryByTestId('telemetry-workspace')).toBeNull();
  });

  it('lets a section heading and its live rows shrink with the rail', async () => {
    processes = [{ ...process1, command: LONG_COMMAND }];
    await renderRail();
    const section = await screen.findByTestId('telemetry-processes');
    expect(classesOf(within(section).getByText('Processes'))).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));

    const row = within(section).getByRole('button', { name: 'Show the process output' });
    // `w-full` beside the row's fixed-size icon asks for more width than the row has to give.
    expect(classesOf(row)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    expect(classesOf(row)).not.toContain('w-full');
    expect(classesOf(within(row).getByText(LONG_COMMAND))).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });

  it('counts running sub-agents with the Czech plural forms', async () => {
    localStorage.setItem('elowen-locale', 'cs');
    const es = await renderRail();
    es.emit('snapshot', snapshot({
      events: [
        ...subagentEvents({ id: 't1', sessionId: 'child-1', status: 'running', task: 'jedna' }),
        ...subagentEvents({ id: 't2', sessionId: 'child-2', status: 'running', task: 'dva' }),
      ],
    }));
    const section = await screen.findByTestId('telemetry-agents');
    await waitFor(() => expect(section.textContent).toContain('2 agenti'));
  });
});
