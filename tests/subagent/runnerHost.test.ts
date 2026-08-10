import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SubagentRunnerHost } from '../../src/subagent/runnerHost.js';
import { subagentBuildId, type DaemonToRunner, type RunnerToDaemon } from '../../src/subagent/protocol.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';

const request: DelegatedTurnRequest = {
  channelId: 'subagent-sub-dlg-1',
  ownerUserId: 1,
  parentSessionId: 'brain-1',
  delegatedAccess: { admin: false, projectIds: [3], owner: true, permissionBoundary: null },
  scheduled: false,
};

/** A stand-in for the forked child: the same IPC surface the host uses, driven by the test. Lets the
 *  handshake and the DEATH path be exercised without booting a real brain in a second process. */
class FakeChild extends EventEmitter {
  readonly pid = 0; // setPriority(0) would renice this very test process — 0 means "no pid to nice"
  connected = true;
  readonly received: DaemonToRunner[] = [];
  killed: string[] = [];
  send(message: DaemonToRunner): boolean {
    this.received.push(message);
    return true;
  }
  kill(signal: string): boolean { this.killed.push(signal); return true; }
  /** What the runner says back. */
  reply(message: RunnerToDaemon): void { this.emit('message', message); }
  die(code = 1, signal: string | null = null): void { this.connected = false; this.emit('exit', code, signal); }
  asChild(): ChildProcess { return this as unknown as ChildProcess; }
}

function hostWith(child: FakeChild, edges?: (parent: string, childSessionId: string, running: boolean) => void) {
  const host = new SubagentRunnerHost({
    dbPath: '/tmp/elowen-test.db',
    project: { id: 1, slug: 'e2e', path: '/tmp/project' },
    cwd: '/tmp/project',
    fork: () => child.asChild(),
  });
  if (edges) host.attachChildEdgeSink(edges);
  return host;
}

/** Let the host's own promise chain (fork → handshake → send) settle before asserting on it. */
const tick = (): Promise<void> => new Promise((r) => { setImmediate(r); });

/** Complete the boot handshake the way a healthy runner does. */
const ready = (child: FakeChild): void => { child.reply({ type: 'ready', buildId: subagentBuildId() }); };

describe('SubagentRunnerHost — the forked runner as seen from the daemon', () => {
  it('boots with the database + project it must attach to, then serves the turn', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    expect(child.received[0]).toMatchObject({ type: 'boot', dbPath: '/tmp/elowen-test.db', project: { slug: 'e2e' } });
    ready(child);
    await tick();
    const turn = child.received.find((m) => m.type === 'turn');
    expect(turn).toMatchObject({ type: 'turn', text: 'do it' });
    child.reply({ type: 'result', turnId: (turn as { turnId: string }).turnId, reply: 'child done' });
    expect(await run).toBe('child done');
  });

  it('rejects a host call after its daemon-owned turn identity has expired', async () => {
    const child = new FakeChild();
    let called = false;
    const host = new SubagentRunnerHost({
      dbPath: '/tmp/elowen-test.db',
      project: { id: 1, slug: 'e2e', path: '/tmp/project' },
      cwd: '/tmp/project',
      fork: () => child.asChild(),
      hostRpc: async () => { called = true; return { added: ['impossible'] }; },
    });
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const { turnId } = child.received.find((message) => message.type === 'turn') as { turnId: string };
    child.reply({ type: 'result', turnId, reply: 'done' });
    await run;

    child.reply({
      type: 'hostCall', callId: 'late', turnId,
      request: { method: 'workflow.addNodes', workflowId: 'wf-late', nodes: [] },
    });
    await tick();
    expect(called).toBe(false);
    expect(child.received).toContainEqual(expect.objectContaining({
      type: 'hostError', callId: 'late', message: expect.stringContaining('no longer active'),
    }));
  });

  it('rejects a host call denied by the daemon-owned turn policy', async () => {
    const child = new FakeChild();
    let called = false;
    const host = new SubagentRunnerHost({
      dbPath: '/tmp/elowen-test.db',
      project: { id: 1, slug: 'e2e', path: '/tmp/project' },
      cwd: '/tmp/project',
      fork: () => child.asChild(),
      hostRpc: async () => { called = true; return { added: ['impossible'] }; },
    });
    const denied = {
      ...request,
      delegatedAccess: {
        ...request.delegatedAccess,
        toolPolicy: { deny: ['Workflow*'] },
      },
    };
    const run = host.run(denied, 'do it');
    await tick();
    ready(child);
    await tick();
    const { turnId } = child.received.find((message) => message.type === 'turn') as { turnId: string };
    child.reply({
      type: 'hostCall', callId: 'denied', turnId,
      request: { method: 'workflow.addNodes', workflowId: 'wf-live', nodes: [] },
    });
    await tick();
    expect(called).toBe(false);
    expect(child.received).toContainEqual(expect.objectContaining({
      type: 'hostError', callId: 'denied', message: expect.stringContaining('not allowed'),
    }));
    child.reply({ type: 'result', turnId, reply: 'done' });
    await run;
  });

  it('replays only the child progress the runner sent, into the delegating turn', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const seen: unknown[] = [];
    const run = host.run(request, 'do it', (e) => seen.push(e));
    await tick();
    ready(child);
    await tick();
    const { turnId } = child.received.find((m) => m.type === 'turn') as { turnId: string };
    child.reply({ type: 'progress', turnId, event: { type: 'tool', name: 'Bash', detail: 'ls' } });
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
    expect(seen).toEqual([{ type: 'tool', name: 'Bash', detail: 'ls' }]);
  });

  // A runner that dies mid-turn leaves parents waiting for ever unless the daemon settles them itself.
  it('settles every in-flight turn as INTERRUPTED when the runner dies', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const first = host.run(request, 'a');
    await tick();
    ready(child);
    await tick();
    const second = host.run({ ...request, channelId: 'subagent-sub-dlg-2' }, 'b');
    await tick();
    child.die(139, 'SIGSEGV');
    await expect(first).rejects.toThrow('the sub-agent runner exited — this delegated turn was interrupted');
    await expect(second).rejects.toThrow('interrupted');
  });

  it('expires mutation authority when the runner dies during a reverse RPC', async () => {
    const child = new FakeChild();
    let releaseRpc!: () => void;
    const rpcGate = new Promise<void>((resolve) => { releaseRpc = resolve; });
    let mutated = false;
    const host = new SubagentRunnerHost({
      dbPath: '/tmp/elowen-test.db',
      project: { id: 1, slug: 'e2e', path: '/tmp/project' },
      cwd: '/tmp/project',
      fork: () => child.asChild(),
      hostRpc: async (caller) => {
        await rpcGate;
        if (!caller.isActive()) throw new Error('the host RPC caller turn is no longer active');
        mutated = true;
        return { added: ['late'] };
      },
    });
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const { turnId } = child.received.find((message) => message.type === 'turn') as { turnId: string };
    child.reply({
      type: 'hostCall', callId: 'mid-crash', turnId,
      request: { method: 'workflow.addNodes', workflowId: 'wf-live', nodes: [] },
    });
    await tick();
    child.die(139, 'SIGSEGV');
    await expect(run).rejects.toThrow('interrupted');
    releaseRpc();
    await tick();
    expect(mutated).toBe(false);
  });

  it('expires mutation authority immediately when the daemon aborts the turn', async () => {
    const child = new FakeChild();
    let releaseRpc!: () => void;
    const rpcGate = new Promise<void>((resolve) => { releaseRpc = resolve; });
    let mutated = false;
    const host = new SubagentRunnerHost({
      dbPath: '/tmp/elowen-test.db',
      project: { id: 1, slug: 'e2e', path: '/tmp/project' },
      cwd: '/tmp/project',
      fork: () => child.asChild(),
      hostRpc: async (caller) => {
        await rpcGate;
        if (!caller.isActive()) throw new Error('the host RPC caller turn is no longer active');
        mutated = true;
        return { added: ['late'] };
      },
    });
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const { turnId } = child.received.find((message) => message.type === 'turn') as { turnId: string };
    child.reply({
      type: 'hostCall', callId: 'mid-abort', turnId,
      request: { method: 'workflow.addNodes', workflowId: 'wf-live', nodes: [] },
    });
    await tick();
    host.abort(request.channelId);
    releaseRpc();
    await tick();
    expect(mutated).toBe(false);
    expect(child.received).toContainEqual(expect.objectContaining({
      type: 'hostError', callId: 'mid-abort', message: expect.stringContaining('no longer active'),
    }));
    child.reply({ type: 'error', turnId, message: 'aborted' });
    await expect(run).rejects.toThrow('aborted');
  });

  // The daemon's registry is the authoritative abort tree. A nested edge left behind by a dead runner
  // would make it believe work is still live: `/stop` would wait on it and shutdown would never drain.
  it('retracts every mirrored nested edge when the runner dies', async () => {
    const child = new FakeChild();
    const edges: [string, string, boolean][] = [];
    const host = hostWith(child, (parent, childSessionId, running) => edges.push([parent, childSessionId, running]));
    const run = host.run(request, 'a');
    await tick();
    ready(child);
    await tick();
    child.reply({ type: 'child', parentSessionId: 'brain-ch-subagent-sub-dlg-1', childSessionId: 'brain-ch-subagent-sub-dlg-9', running: true });
    child.die();
    await expect(run).rejects.toThrow('interrupted');
    expect(edges).toEqual([
      ['brain-ch-subagent-sub-dlg-1', 'brain-ch-subagent-sub-dlg-9', true],
      ['brain-ch-subagent-sub-dlg-1', 'brain-ch-subagent-sub-dlg-9', false],
    ]);
  });

  // An in-place rebuild under a live daemon forks a child from code the parent is not running.
  it('refuses a runner reporting a different build, and kills it', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    child.reply({ type: 'ready', buildId: 'elowen-from-another-build' });
    await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(child.killed).toContain('SIGKILL');
  });

  it('reports a runner that refused to boot as unavailable (so the caller may run the turn itself)', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    child.reply({ type: 'fatal', reason: 'the brain is not available for this database' });
    await expect(run).rejects.toThrow(/refused to start/);
  });

  it('does not fork again for a while after a failed boot — one failure must not become a fork storm', async () => {
    const child = new FakeChild();
    let forks = 0;
    const host = new SubagentRunnerHost({
      dbPath: '/tmp/elowen-test.db',
      project: { id: 1, slug: 'e2e', path: '/tmp/project' },
      cwd: '/tmp/project',
      fork: () => { forks += 1; return child.asChild(); },
    });
    const first = host.run(request, 'a');
    await tick();
    child.reply({ type: 'fatal', reason: 'boom' });
    await expect(first).rejects.toThrow();
    await expect(host.run(request, 'b')).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(forks).toBe(1);
  });

  it('release answers `busy` for a channel the runner is still working on, and frees an idle one', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const pending = host.release('subagent-sub-dlg-1');
    await tick();
    const asked = child.received.find((m) => m.type === 'release') as { releaseId: string };
    child.reply({ type: 'released', releaseId: asked.releaseId, busy: true });
    expect(await pending).toEqual({ busy: true });
    const { turnId } = child.received.find((m) => m.type === 'turn') as { turnId: string };
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('treats a runner that is not running as holding nothing (release resolves free)', async () => {
    const host = hostWith(new FakeChild());
    expect(await host.release('subagent-sub-dlg-1')).toEqual({ busy: false });
  });

  it('queries runner-local plugin activity with correlation', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();

    const activity = host.activeCount();
    await tick();
    const asked = child.received.find((m) => m.type === 'activity') as Extract<DaemonToRunner, { type: 'activity' }>;
    child.reply({ type: 'activity', activityId: 'someone-elses-query', activeCount: 99 });
    child.reply({ type: 'activity', activityId: asked.activityId, activeCount: 2 });
    expect(await activity).toBe(2);

    const { turnId } = child.received.find((m) => m.type === 'turn') as Extract<DaemonToRunner, { type: 'turn' }>;
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('fails closed when a live runner does not answer an activity query', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();

    vi.useFakeTimers();
    try {
      const activity = host.activeCount();
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(activity).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }

    const { turnId } = child.received.find((m) => m.type === 'turn') as Extract<DaemonToRunner, { type: 'turn' }>;
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('fails closed when an activity query cannot be sent to a still-live runner', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();

    child.send = () => false;
    await expect(host.activeCount()).resolves.toBe(1);

    const { turnId } = child.received.find((m) => m.type === 'turn') as Extract<DaemonToRunner, { type: 'turn' }>;
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('returns the runner-owned atomic snapshot and relays full live drill-in events until untapped', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();

    const seen: unknown[] = [];
    const pendingTap = host.tapSessionSnapshot(1, 'brain-ch-subagent-sub-dlg-1', (event) => seen.push(event), { limit: 40 });
    await tick();
    const asked = child.received.find((m) => m.type === 'tap') as Extract<DaemonToRunner, { type: 'tap' }>;
    expect(asked).toMatchObject({ userId: 1, sessionId: 'brain-ch-subagent-sub-dlg-1', history: { limit: 40 } });
    // Events can race the snapshot IPC response. The host must already relay them; the HTTP route buffers
    // this suffix until it has written the snapshot frame.
    child.reply({ type: 'tap-event', tapId: asked.tapId, event: { type: 'text', delta: 'racing suffix' } });
    const snapshot = { type: 'snapshot' as const, cursor: 9, history: [], events: [{ type: 'tool', name: 'Read' } as const] };
    child.reply({ type: 'tapped', tapId: asked.tapId, snapshot });
    const attached = await pendingTap;
    expect(attached?.snapshot).toEqual(snapshot);
    child.reply({ type: 'tap-event', tapId: asked.tapId, event: { type: 'tool_progress', id: 't1', text: 'live output' } });
    expect(seen).toEqual([
      { type: 'text', delta: 'racing suffix' },
      { type: 'tool_progress', id: 't1', text: 'live output' },
    ]);
    attached?.off();
    expect(child.received).toContainEqual({ type: 'untap', tapId: asked.tapId });

    const { turnId } = child.received.find((m) => m.type === 'turn') as { turnId: string };
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('steer forwards the text to the runner and resolves with ITS verdict', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const pending = host.steer('subagent-sub-dlg-1', 'also check the docs');
    await tick();
    const asked = child.received.find((m) => m.type === 'steer') as { steerId: string; channelId: string; text: string };
    expect(asked).toMatchObject({ channelId: 'subagent-sub-dlg-1', text: 'also check the docs' });
    // A verdict for a DIFFERENT steer must not settle this one — correlation is by id, so a stray frame
    // resolving it would hand the caller another channel's outcome.
    child.reply({ type: 'steered', steerId: 'someone-elses-steer', outcome: 'idle' });
    child.reply({ type: 'steered', steerId: asked.steerId, outcome: 'delivered' });
    expect(await pending).toEqual({ outcome: 'delivered' });
    // A steered verdict for a DIFFERENT request must not have settled this one — correlation is by id.
    const { turnId } = child.received.find((m) => m.type === 'turn') as { turnId: string };
    child.reply({ type: 'result', turnId, reply: 'ok' });
    await run;
  });

  it('steer resolves idle when the runner dies before answering — the caller falls back', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    const pending = host.steer('subagent-sub-dlg-1', 'late instruction');
    await tick();
    child.die(139, 'SIGSEGV');
    expect(await pending).toEqual({ outcome: 'idle' });
    await expect(run).rejects.toThrow('interrupted');
  });

  it('steer on a runner that is not running resolves idle without forking one', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    expect(await host.steer('subagent-sub-dlg-1', 'hello')).toEqual({ outcome: 'idle' });
    expect(child.received).toEqual([]); // no boot, no steer — nothing of this channel can be running there
  });

  it('reset kills the child and settles what it was running', async () => {
    const child = new FakeChild();
    const host = hostWith(child);
    const run = host.run(request, 'do it');
    await tick();
    ready(child);
    await tick();
    host.reset('plugins reloaded');
    expect(child.killed).toContain('SIGTERM');
    child.die(0, 'SIGTERM'); // the child exits in response, as a real one does
    await expect(run).rejects.toThrow('interrupted');
  });
});
