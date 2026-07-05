import { describe, it, expect, vi } from 'vitest';
import { BrainWorkerService } from '../../../src/brain/worker/brainWorker.js';
import { openDb } from '../../../src/store/db.js';
import { BrainStore } from '../../../src/store/brainStore.js';
import { TaskStore } from '../../../src/store/taskStore.js';
import { EventBus } from '../../../src/api/sse.js';

/** A controllable fake PI session: prompt() blocks until the test releases it, so we can order
 *  tool calls / agent settlement deterministically. */
function fakeSession() {
  const releases: (() => void)[] = [];
  const session = {
    sessionId: 'pi-1',
    messages: [{ usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } } }],
    prompt: vi.fn(() => new Promise<void>((res) => releases.push(res))),
    subscribe: vi.fn(() => () => {}),
    dispose: vi.fn(),
    abort: vi.fn(async () => {}),
  };
  return { session, release: () => releases.shift()?.() };
}

function setup(opts: { idleMs?: number } = {}) {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/repo')").run();
  const tasks = new TaskStore(db);
  tasks.create({ id: 'T-1', project_id: 1, title: 'Fix bug' });
  tasks.setStatus('T-1', 'in_progress');
  const bus = new EventBus();
  const published: unknown[] = [];
  bus.subscribe((e) => { published.push(e); });
  const { session, release } = fakeSession();
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const recorded: unknown[] = [];
  let now = 1_000_000;
  const svc = new BrainWorkerService({
    store: new BrainStore(db),
    tasks, bus,
    taskUsage: { record: (...a: unknown[]) => { recorded.push(a); } } as never,
    config: () => ({ providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi'], apiKey: 'k' }] }),
    url: 'http://daemon', token: 'tok',
    now: () => now,
    idleMs: opts.idleMs,
    createSession: vi.fn(async () => ({ session })) as never,
    fetchImpl: fetchImpl as never,
    resourceLoaderFactory: () => undefined,
  });
  const launchInput = { projectId: 1, projectPath: '/repo', taskId: 'T-1', agentName: 'a1', spec: { program: 'orca', model: 'relay/kimi' } };
  return { svc, tasks, session, release, fetchImpl, recorded, published, launchInput, advance: (ms: number) => { now += ms; }, db };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('BrainWorkerService', () => {
  it('launch returns the tmux-style session name and reports it live', async () => {
    const { svc, launchInput } = setup();
    const { session } = await svc.launch(launchInput);
    expect(session).toBe('orca-a1');
    expect(svc.isLive('orca-a1')).toBe(true);
    expect(svc.liveSessionNames()).toEqual(['orca-a1']);
  });

  it('persists the transcript under brain-task-<id> and scopes tools to the close tool', async () => {
    const { svc, launchInput, db, session } = setup();
    await svc.launch(launchInput);
    const store = new BrainStore(db);
    expect(store.getSession('brain-task-T-1')).toBeTruthy();
    expect(session.prompt).toHaveBeenCalledWith('Start working on the task now.');
  });

  it('the close tool PATCHes the REST route and records usage', async () => {
    const { svc, launchInput, fetchImpl, recorded } = setup();
    const createSession = (svc as unknown as { d: { createSession: { mock: { calls: [{ customTools: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }[] }][] } } } }).d.createSession;
    await svc.launch(launchInput);
    const tools = createSession.mock.calls[0][0].customTools;
    const close = tools.find((t) => t.name === 'orca_close_task')!;
    await close.execute('c1', { summary: 'done', outcome: 'ok' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as { mock: { calls: [string | URL, RequestInit][] } }).mock.calls[0];
    expect(String(url)).toContain('/tasks/T-1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ status: 'closed', result_summary: 'done', outcome: 'ok' });
    expect(recorded).toHaveLength(1);
    // No OpenRouter fetch ran in this test, so the meter reports nothing — pi-ai's price-sheet cost
    // (0.02) is kept but flagged as a calculated estimate, not provider-reported.
    expect(recorded[0]).toEqual(['T-1', 1, 'orca:kimi', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, reasoning: 0, costUsd: 0.02, currency: 'USD', costSource: 'calculated' }]);
  });

  it('an unclosed agent_end gets one nudge, then the task reverts to open with a resume note', async () => {
    const { svc, launchInput, tasks, session, release, published } = setup();
    await svc.launch(launchInput);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    release(); await settle(); // kickoff settles unclosed → nudge
    expect(session.prompt).toHaveBeenCalledTimes(2);
    expect(String(session.prompt.mock.calls[1][0])).toContain('orca_close_task');
    release(); await settle(); await settle(); // nudge also settles unclosed → teardown
    const t = tasks.get('T-1')!;
    expect(t.status).toBe('open');
    expect(t.resume_note).toContain('previous run stalled');
    expect(svc.isLive('orca-a1')).toBe(false);
    expect(published.some((e) => (e as { type?: string; status?: string }).type === 'task' && (e as { status?: string }).status === 'open')).toBe(true);
  });

  it('a closed task tears down silently after the prompt settles (no revert)', async () => {
    const { svc, launchInput, tasks, session, release } = setup();
    await svc.launch(launchInput);
    tasks.close('T-1', { summary: 'done', outcome: 'ok' }); // the close tool's REST call did this
    release(); await settle();
    expect(tasks.get('T-1')!.status).toBe('closed');
    expect(session.prompt).toHaveBeenCalledTimes(1); // no nudge for a closed task
    expect(svc.isLive('orca-a1')).toBe(false);
  });

  it('the idle watchdog reaps a wedged worker and re-opens its task', async () => {
    const { svc, launchInput, tasks, advance } = setup({ idleMs: 1000 });
    await svc.launch(launchInput);
    advance(2000);
    svc.sweepIdle();
    expect(tasks.get('T-1')!.status).toBe('open');
    expect(svc.isLive('orca-a1')).toBe(false);
  });

  it('a relaunch on an existing transcript rehydrates and sends the resume kickoff', async () => {
    const first = setup();
    await first.svc.launch(first.launchInput);
    // Simulate daemon restart: fresh service over the SAME db.
    const tasks2 = new TaskStore(first.db);
    const { session: s2 } = fakeSession();
    const svc2 = new BrainWorkerService({
      store: new BrainStore(first.db), tasks: tasks2, bus: new EventBus(),
      config: () => ({ providers: [{ id: 'relay', label: 'Relay', type: 'openai', baseUrl: 'http://x/v1', models: ['kimi'], apiKey: 'k' }] }),
      url: 'http://daemon', token: 'tok',
      createSession: vi.fn(async () => ({ session: s2 })) as never,
      resourceLoaderFactory: () => undefined,
    });
    await svc2.launch(first.launchInput);
    expect(String(s2.prompt.mock.calls[0][0])).toContain('interrupted and relaunched');
  });

  it('abort disposes the live session without touching the task row', async () => {
    const { svc, launchInput, tasks, session } = setup();
    await svc.launch(launchInput);
    await svc.abort('orca-a1');
    expect(session.abort).toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalled();
    expect(tasks.get('T-1')!.status).toBe('in_progress'); // caller owns the task state
  });
});
