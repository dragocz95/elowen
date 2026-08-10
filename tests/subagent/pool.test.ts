import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SubagentRunnerPool } from '../../src/subagent/pool.js';
import { subagentBuildId, type DaemonToRunner, type RunnerToDaemon } from '../../src/subagent/protocol.js';
import { IDLE_REAP_MS, MAX_TURNS_PER_RUNNER, type MachineInputs } from '../../src/subagent/sizing.js';
import { SubagentRunnerUnavailable, type DelegatedTurnRequest } from '../../src/brain/delegatedTurn.js';
import type { McpBridgeSnapshot } from '../../src/plugins/mcpSnapshot.js';

const GB = 1024 ** 3;

/** A stand-in for one forked runner: the IPC surface the host uses, driven by the test. Lets placement,
 *  routing and the death path be exercised without booting a real brain in N second processes. */
class FakeChild extends EventEmitter {
  readonly pid = 0; // setPriority(0) would renice this very test process — 0 means "no pid to nice"
  connected = true;
  readonly received: DaemonToRunner[] = [];
  killed: string[] = [];
  send(message: DaemonToRunner): boolean { this.received.push(message); return true; }
  kill(signal: string): boolean { this.killed.push(signal); return true; }
  reply(message: RunnerToDaemon): void { this.emit('message', message); }
  die(code = 1, signal: string | null = null): void { this.connected = false; this.emit('exit', code, signal); }
  asChild(): ChildProcess { return this as unknown as ChildProcess; }
  /** Complete the boot handshake the way a healthy runner does. */
  boot(): void { this.reply({ type: 'ready', buildId: subagentBuildId() }); }
  /** Turn frames it has been handed, oldest first. */
  turns(): { turnId: string; text: string }[] {
    return this.received.filter((m): m is Extract<DaemonToRunner, { type: 'turn' }> => m.type === 'turn')
      .map((m) => ({ turnId: m.turnId, text: m.text }));
  }
  finish(turnId: string, reply = 'ok'): void { this.reply({ type: 'result', turnId, reply }); }
}

const machine = (cores: number, totalGB: number, availGB = totalGB * 0.8): MachineInputs => ({
  cpus: () => cores,
  totalMemBytes: () => totalGB * GB,
  availableMemBytes: () => availGB * GB,
});

const request = (channelId: string, parentSessionId = 'brain-1'): DelegatedTurnRequest => ({
  channelId,
  ownerUserId: 1,
  parentSessionId,
  delegatedAccess: { admin: false, projectIds: [3], owner: true, permissionBoundary: null },
  scheduled: false,
});

interface Harness {
  pool: SubagentRunnerPool;
  children: FakeChild[];
}

function poolWith(opts: {
  machine?: MachineInputs;
  poolMax?: () => number | null;
  enabled?: () => boolean;
  mcpBridgeSnapshot?: () => Promise<McpBridgeSnapshot | undefined>;
} = {}): Harness {
  const children: FakeChild[] = [];
  const pool = new SubagentRunnerPool({
    dbPath: '/tmp/elowen-test.db',
    project: { id: 1, slug: 'e2e', path: '/tmp/project' },
    cwd: '/tmp/project',
    fork: () => { const c = new FakeChild(); children.push(c); return c.asChild(); },
    machine: opts.machine ?? machine(16, 64),
    ...(opts.poolMax ? { poolMax: opts.poolMax } : {}),
    ...(opts.enabled ? { enabled: opts.enabled } : {}),
    ...(opts.mcpBridgeSnapshot ? { mcpBridgeSnapshot: opts.mcpBridgeSnapshot } : {}),
  });
  return { pool, children };
}

/** The boot frame a child was handed — what travelled with the fork. */
const bootFrame = (child: FakeChild): Extract<DaemonToRunner, { type: 'boot' }> | undefined =>
  child.received.find((m): m is Extract<DaemonToRunner, { type: 'boot' }> => m.type === 'boot');

/** Let the pool's promise chain (fork → handshake → place → send) settle. */
const settle = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => { setImmediate(r); });
};

/** Bring the pool's FIRST runner up: kick off a turn, complete the handshake, hand back the turn still
 *  in flight. WRAPPED in an object on purpose — returning the promise bare would let `await` flatten it
 *  and wait for the delegated turn to finish, which is precisely what these tests drive by hand. */
async function coldStart(h: Harness, channelId = 'subagent-sub-dlg-1'): Promise<{ run: Promise<string> }> {
  const run = fire(h.pool.run(request(channelId), 'first'));
  await settle();
  h.children[0]?.boot();
  await settle();
  return { run };
}

/** A turn nobody in the test awaits. The pool rejects everything still in flight on `reset`, so without
 *  this every teardown would raise an unhandled rejection that has nothing to do with the assertion. */
const fire = (p: Promise<string>): Promise<string> => { p.catch(() => { /* asserted where it matters */ }); return p; };

afterEach(() => { vi.useRealTimers(); });

describe('SubagentRunnerPool — cold start and the operator knob', () => {
  it('forks one runner on the first turn and serves it there', async () => {
    const h = poolWith();
    const { run } = await coldStart(h);
    expect(h.children).toHaveLength(1);
    const [turn] = h.children[0]!.turns();
    expect(turn?.text).toBe('first');
    h.children[0]!.finish(turn!.turnId, 'child done');
    expect(await run).toBe('child done');
    h.pool.reset('test over');
  });

  it('aggregates exact in-flight work with runner-local plugin activity', async () => {
    const h = poolWith();
    const { run } = await coldStart(h);
    const child = h.children[0]!;

    const active = h.pool.activeCount();
    await settle();
    const query = child.received.find((m): m is Extract<DaemonToRunner, { type: 'activity' }> => m.type === 'activity')!;
    child.reply({ type: 'activity', activityId: query.activityId, activeCount: 3 });
    expect(await active).toBe(3);

    child.finish(child.turns()[0]!.turnId);
    await run;
    const idle = h.pool.activeCount();
    await settle();
    const queries = child.received.filter((m): m is Extract<DaemonToRunner, { type: 'activity' }> => m.type === 'activity');
    child.reply({ type: 'activity', activityId: queries.at(-1)!.activityId, activeCount: 0 });
    expect(await idle).toBe(0);
    h.pool.reset('test over');
  });

  // 0 is the operator saying "do not use the pool at all". The dispatcher must see `in-process`, not a
  // runner that fails once per delegated turn.
  it('reports itself unusable and forks nothing at pool max 0', async () => {
    const h = poolWith({ poolMax: () => 0 });
    expect(h.pool.usable()).toBe(false);
    await expect(h.pool.run(request('subagent-sub-dlg-1'), 'x')).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(h.children).toHaveLength(0);
    expect(h.pool.stats().mode).toBe('in-process');
  });

  // /health is where an operator confirms a rollback took effect. Reporting `runner` because the MACHINE
  // allows one, while the switch routes every delegated turn in-process, tells them their rollback failed
  // when it worked — the one lie this block must never tell.
  it('reports in-process while the switch is off, however roomy the machine', () => {
    let on = false;
    const h = poolWith({ enabled: () => on });
    expect(h.pool.stats().cap).toBeGreaterThan(0);
    expect(h.pool.stats().mode).toBe('in-process');
    on = true;
    expect(h.pool.stats().mode).toBe('runner');
  });

  // The knob is read LIVE, so an operator can widen or close the pool without a restart.
  it('follows the knob between turns', async () => {
    let max: number | null = 0;
    const h = poolWith({ poolMax: () => max });
    expect(h.pool.usable()).toBe(false);
    max = 2;
    expect(h.pool.usable()).toBe(true);
    expect(h.pool.stats().cap).toBe(2);
    h.pool.reset('test over');
  });

  // MEASURED IN PRODUCTION: 20 delegations arriving together at an empty pool. Every one of them passes
  // the "no runners yet" test before the first spawn resolves, so all 20 land in the cold-start branch —
  // and the ones that do not fit the first runner used to be told the pool was UNAVAILABLE. The
  // dispatcher believed it and ran them on the daemon's own loop: 12 of 20 in-process, the loop stalled
  // for 8s, /health timed out. Congestion must queue; only a runner that cannot boot is unavailable.
  it('queues a cold-start burst instead of refusing what does not fit', async () => {
    const h = poolWith();
    // Record refusals as they land instead of awaiting the burst: the turns that queue are SUPPOSED to
    // stay pending here (nothing completes them), so awaiting them would hang the test by design.
    const refused: unknown[] = [];
    for (let i = 0; i < 20; i += 1) {
      h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`).catch((e: unknown) => { refused.push(e); });
    }
    await settle();
    h.children[0]?.boot();
    await settle(8);
    // Not one of them may have been refused — the whole point is that the daemon's loop stays free.
    expect(refused.filter((e) => e instanceof SubagentRunnerUnavailable)).toHaveLength(0);
    expect(h.children[0]!.turns()).toHaveLength(MAX_TURNS_PER_RUNNER);
    expect(h.pool.stats().queueDepth).toBe(20 - MAX_TURNS_PER_RUNNER);
    h.pool.reset('test over');
  });

  // A cold start that cannot boot must be reported, not waited on: the dispatcher's whole fallback to
  // in-process depends on getting a straight answer here.
  it('reports a runner that refuses to boot as unavailable', async () => {
    const h = poolWith();
    const run = h.pool.run(request('subagent-sub-dlg-1'), 'x');
    await settle();
    h.children[0]!.reply({ type: 'fatal', reason: 'no brain for this database' });
    await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
  });

  // `mode` reports the CONFIGURATION, so a pool whose every fork is refused reads exactly like an idle
  // one: `runner`, empty list, queue 0. That is the state a daemon running an older build than `dist/`
  // sits in — every delegated turn quietly served in-process — and the dispatcher's fallback means
  // nothing else surfaces it. The reason has to reach the place an operator actually looks.
  it('surfaces why a fork was refused, and clears it once one succeeds', async () => {
    const h = poolWith();
    expect(h.pool.stats().spawnFailure).toBeNull();

    const refuse = async (channel: string, index: number): Promise<void> => {
      const run = fire(h.pool.run(request(channel), 'x'));
      await settle();
      h.children[index]!.reply({ type: 'fatal', reason: 'build mismatch (daemon 0.27.80, runner 0.27.81)' });
      await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    };

    await refuse('subagent-sub-dlg-1', 0);
    expect(h.pool.stats().spawnFailure?.code).toBe('build_mismatch');
    expect(h.pool.stats().spawnFailure?.consecutive).toBe(1);
    // The stats block feeds the unauthenticated /health verbatim, so the raw reason — which quotes
    // build ids, and for other failures internal paths and configuration — must never appear in it.
    expect(JSON.stringify(h.pool.stats())).not.toContain('0.27.80');

    // Consecutive refusals are what separate a one-off hiccup from a pool that cannot work at all.
    await refuse('subagent-sub-dlg-2', 1);
    expect(h.pool.stats().spawnFailure?.consecutive).toBe(2);

    fire(h.pool.run(request('subagent-sub-dlg-3'), 'x'));
    await settle();
    h.children[2]!.boot();
    await settle();
    expect(h.pool.stats().runners).toHaveLength(1);
    expect(h.pool.stats().spawnFailure).toBeNull();
  });

  // A refusal describes ONE epoch of the pool. Kept past a reset it becomes an alarm that can never
  // turn off: `agoMs` grows forever after the environment is fixed, and the next epoch's first failure
  // would count `consecutive` on top of a run that was not consecutive at all.
  it('reset() clears the spawn failure — the next epoch starts clean', async () => {
    const h = poolWith();
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'x'));
    await settle();
    h.children[0]!.reply({ type: 'fatal', reason: 'build mismatch (daemon 0.27.80, runner 0.27.81)' });
    await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(h.pool.stats().spawnFailure?.code).toBe('build_mismatch');
    h.pool.reset('plugin reload');
    expect(h.pool.stats().spawnFailure).toBeNull();
  });

  // Same epoch rule for the operator's switch: a pool that no longer forks anything has no CURRENT
  // spawn failure, and the stale one must not resurface when the switch comes back on.
  it('switching runner mode off retires the spawn failure', async () => {
    let on = true;
    const h = poolWith({ enabled: () => on });
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'x'));
    await settle();
    h.children[0]!.reply({ type: 'fatal', reason: 'build mismatch (daemon 0.27.80, runner 0.27.81)' });
    await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(h.pool.stats().spawnFailure?.code).toBe('build_mismatch');
    on = false;
    expect(h.pool.stats().spawnFailure).toBeNull();
    on = true;
    expect(h.pool.stats().spawnFailure).toBeNull();
    h.pool.reset('test over');
  });
});

describe('SubagentRunnerPool — placement and routing', () => {
  it('pins a session to ONE runner for its lifetime', async () => {
    const h = poolWith();
    const { run: first } = await coldStart(h, 'subagent-sub-dlg-1');
    // Grow to a second runner by hand, so placement has a genuine choice to get wrong.
    fire(h.pool.run(request('subagent-sub-dlg-2', 'brain-2'), 'other'));
    await settle();
    // A continuation of the FIRST channel must go back to the runner already holding it, even though the
    // pool now has a second, less loaded one.
    fire(h.pool.run(request('subagent-sub-dlg-1'), 'continue'));
    await settle();
    expect(h.children[0]!.turns().map((t) => t.text)).toContain('continue');
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId);
    await first;
    h.pool.reset('test over');
  });

  it('spreads unrelated sessions onto the least loaded runner', async () => {
    const h = poolWith();
    const { run: first } = await coldStart(h, 'subagent-sub-dlg-1');
    // One runner, room for MAX_TURNS_PER_RUNNER: everything lands there and nothing queues.
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`));
    await settle();
    expect(h.children[0]!.turns()).toHaveLength(MAX_TURNS_PER_RUNNER);
    expect(h.pool.stats().queueDepth).toBe(0);
    expect(h.pool.stats().runners[0]?.activeTurns).toBe(MAX_TURNS_PER_RUNNER);
    void first;
    h.pool.reset('test over');
  });

  // A runner that dies must never leave a parent waiting, and must never leave a route pointing at a
  // process that is gone — the next continuation has to be placeable somewhere else.
  it('settles a dead runner’s turns as interrupted and drops its routes', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    expect(h.pool.stats().runners[0]?.sessions).toBe(1);
    h.children[0]!.die(139, 'SIGSEGV');
    await expect(run).rejects.toThrow('interrupted');
    // No runner, no route — the pool is back to a clean cold start.
    expect(h.pool.stats().runners).toHaveLength(0);
    expect(h.pool.stats().queueDepth).toBe(0);
    // …and the very same session can now be placed anywhere, rehydrating from SQLite.
    const again = h.pool.run(request('subagent-sub-dlg-1'), 'after death');
    await settle();
    expect(h.children).toHaveLength(2);
    h.children[1]!.boot();
    await settle();
    expect(h.children[1]!.turns().map((t) => t.text)).toEqual(['after death']);
    h.children[1]!.finish(h.children[1]!.turns()[0]!.turnId, 'recovered');
    expect(await again).toBe('recovered');
    h.pool.reset('test over');
  });

  it('sends abort and release only to the runner actually holding the channel', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    h.pool.abort('subagent-sub-dlg-1');
    expect(h.children[0]!.received.some((m) => m.type === 'abort')).toBe(true);
    // A channel no runner holds needs no round trip at all — the routing map IS the answer.
    expect(await h.pool.release('subagent-sub-dlg-unknown')).toEqual({ busy: false });
    void run;
    h.pool.reset('test over');
  });

  // A successful release is the daemon taking the session back to run it itself. Keeping the route would
  // send the next delegated turn straight back to a runner that no longer has the session.
  it('drops the route when a runner releases a channel', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId);
    await run;
    const pending = h.pool.release('subagent-sub-dlg-1');
    await settle();
    const asked = h.children[0]!.received.find((m) => m.type === 'release') as { releaseId: string };
    h.children[0]!.reply({ type: 'released', releaseId: asked.releaseId, busy: false });
    expect(await pending).toEqual({ busy: false });
    expect(h.pool.stats().runners[0]?.sessions).toBe(0);
    h.pool.reset('test over');
  });

  it('keeps the route when the runner says it is still busy with that channel', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    const pending = h.pool.release('subagent-sub-dlg-1');
    await settle();
    const asked = h.children[0]!.received.find((m) => m.type === 'release') as { releaseId: string };
    h.children[0]!.reply({ type: 'released', releaseId: asked.releaseId, busy: true });
    expect(await pending).toEqual({ busy: true });
    expect(h.pool.stats().runners[0]?.sessions).toBe(1);
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId);
    await run;
    h.pool.reset('test over');
  });

  it('steers only through the runner actually holding the channel, and answers idle for an unrouted one', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    // Unrouted channel: no runner holds it, so no round trip happens and no runner is forked for it —
    // the routing map IS the answer, exactly like release.
    expect(await h.pool.steer('subagent-sub-dlg-unknown', 'hello')).toEqual({ outcome: 'idle' });
    expect(h.children).toHaveLength(1);
    expect(h.children[0]!.received.some((m) => m.type === 'steer')).toBe(false);
    // Routed channel: the steer frame reaches ITS runner and the pool relays that runner's verdict.
    const pending = h.pool.steer('subagent-sub-dlg-1', 'also check the docs');
    await settle();
    const asked = h.children[0]!.received.find((m) => m.type === 'steer') as { steerId: string; text: string };
    expect(asked).toMatchObject({ text: 'also check the docs' });
    h.children[0]!.reply({ type: 'steered', steerId: asked.steerId, outcome: 'delivered' });
    expect(await pending).toEqual({ outcome: 'delivered' });
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId);
    await run;
    h.pool.reset('test over');
  });
});

describe('SubagentRunnerPool — admission is placement, not a cap', () => {
  it('queues a turn that does not fit instead of refusing it, and places it when room appears', async () => {
    // One core ⇒ cap 1 ⇒ exactly MAX_TURNS_PER_RUNNER slots in the whole pool.
    const h = poolWith({ machine: machine(1, 8) });
    const { run: first } = await coldStart(h, 'subagent-sub-dlg-1');
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`));
    await settle();
    expect(h.children[0]!.turns()).toHaveLength(MAX_TURNS_PER_RUNNER);

    // One more than the pool can hold: it WAITS. Refusing here would be a concurrency cap, and
    // time-sharing is the intended behaviour.
    const overflow = h.pool.run(request('subagent-sub-dlg-99', 'brain-99'), 'overflow');
    await settle();
    expect(h.children[0]!.turns()).toHaveLength(MAX_TURNS_PER_RUNNER);
    expect(h.pool.stats().queueDepth).toBe(1);
    expect(h.pool.stats().oldestQueuedMs).toBeGreaterThanOrEqual(0);

    // Free one slot; the queued turn is placed without anyone asking again.
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId, 'done');
    expect(await first).toBe('done');
    await settle();
    expect(h.children[0]!.turns().map((t) => t.text)).toContain('overflow');
    expect(h.pool.stats().queueDepth).toBe(0);
    const placed = h.children[0]!.turns().find((t) => t.text === 'overflow')!;
    h.children[0]!.finish(placed.turnId, 'overflow done');
    expect(await overflow).toBe('overflow done');
    h.pool.reset('test over');
  });

  // Workflow `tick()` launches EVERY ready node at once and workflow nodes do not share the delegate job
  // cap, so a 30-node DAG can flood the queue in one event-loop turn. Plain FIFO would make an unrelated
  // delegation wait for all thirty.
  it('does not let one large workflow starve an unrelated delegation', async () => {
    const h = poolWith({ machine: machine(1, 8) });
    const { run: first } = await coldStart(h, 'subagent-sub-dlg-fill-1');
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-fill-${i}`, `brain-fill-${i}`), `fill${i}`));
    await settle();
    expect(h.pool.stats().queueDepth).toBe(0);

    // The workflow floods first…
    for (let n = 0; n < 30; n += 1) fire(h.pool.run(request(`wf-node-${n}`, 'brain-workflow'), `node${n}`));
    // …and one unrelated delegation arrives LAST, behind all thirty.
    fire(h.pool.run(request('subagent-sub-dlg-lonely', 'brain-someone-else'), 'lonely'));
    await settle();
    expect(h.pool.stats().queueDepth).toBe(31);

    // Free two slots. Round-robin across delegating parents means the lonely turn gets one of them —
    // under FIFO it would be 31st in line.
    const running = h.children[0]!.turns();
    h.children[0]!.finish(running[0]!.turnId);
    h.children[0]!.finish(running[1]!.turnId);
    await settle();
    const placedTexts = h.children[0]!.turns().map((t) => t.text);
    expect(placedTexts).toContain('lonely');
    void first;
    h.pool.reset('test over');
  });

  // Nothing of a queued turn ran anywhere, so the dispatcher may safely run it in-process rather than
  // lose it to a plugin reload.
  it('strands queued turns as unavailable on reset rather than leaving parents waiting', async () => {
    const h = poolWith({ machine: machine(1, 8) });
    const { run: first } = await coldStart(h, 'subagent-sub-dlg-1');
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`));
    await settle();
    const queued = h.pool.run(request('subagent-sub-dlg-99', 'brain-99'), 'queued');
    await settle();
    expect(h.pool.stats().queueDepth).toBe(1);
    h.pool.reset('plugins reloaded');
    await expect(queued).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    h.children[0]!.die(0, 'SIGTERM'); // the child exits in response to the kill, as a real one does
    await expect(first).rejects.toThrow('interrupted'); // in-flight turns settle rather than hang
  });
});

describe('SubagentRunnerPool — growth and shrink', () => {
  // A burst must not become a herd: one workflow tick asking for twenty runners at once would fork twenty
  // cold plugin boots for demand one extra runner absorbs.
  it('spawns at most one extra runner for a burst, however large', async () => {
    vi.useFakeTimers();
    const h = poolWith({ machine: machine(16, 64) });
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'first'));
    await vi.advanceTimersByTimeAsync(1);
    h.children[0]!.boot();
    await vi.advanceTimersByTimeAsync(1);
    // Flood well past one runner's admission limit, all at once.
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER * 3; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`));
    await vi.advanceTimersByTimeAsync(1);
    // The cooldown holds every further spawn behind the first one's boot.
    expect(h.children.length).toBeLessThanOrEqual(2);
    void run;
    h.pool.reset('test over');
  });

  // Growth must never be on the critical path of a turn: a queued turn waits for CAPACITY, not for a cold
  // plugin boot, and the pool keeps time-sharing what it already has meanwhile.
  it('keeps serving from the existing runner while a new one boots', async () => {
    vi.useFakeTimers();
    const h = poolWith({ machine: machine(16, 64) });
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'first'));
    await vi.advanceTimersByTimeAsync(1);
    h.children[0]!.boot();
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 2; i <= MAX_TURNS_PER_RUNNER; i += 1) fire(h.pool.run(request(`subagent-sub-dlg-${i}`, `brain-${i}`), `t${i}`));
    await vi.advanceTimersByTimeAsync(1);
    // Full, and a second runner is booting — the turns already placed keep running regardless.
    expect(h.children[0]!.turns()).toHaveLength(MAX_TURNS_PER_RUNNER);
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId, 'done');
    expect(await run).toBe('done');
    h.pool.reset('test over');
  });

  // The shrink half: a runner that has served nothing for the idle window goes away, and the routing map
  // must be correct AT THAT MOMENT — a reaped runner must not leave a stale route behind.
  it('reaps an idle runner and leaves no stale route', async () => {
    vi.useFakeTimers();
    const h = poolWith();
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'first'));
    await vi.advanceTimersByTimeAsync(1);
    h.children[0]!.boot();
    await vi.advanceTimersByTimeAsync(1);
    h.children[0]!.finish(h.children[0]!.turns()[0]!.turnId, 'done');
    expect(await run).toBe('done');

    // Still routed ⇒ NOT reapable, however long it idles: the route is a promise that the channel lives
    // in this process, and reaping under it would break that promise.
    await vi.advanceTimersByTimeAsync(IDLE_REAP_MS * 2);
    expect(h.pool.stats().runners).toHaveLength(1);
    expect(h.children[0]!.killed).toHaveLength(0);

    // Release the session, then let it go idle: now it may be reaped.
    const released = h.pool.release('subagent-sub-dlg-1');
    await vi.advanceTimersByTimeAsync(1);
    const asked = h.children[0]!.received.find((m) => m.type === 'release') as { releaseId: string };
    h.children[0]!.reply({ type: 'released', releaseId: asked.releaseId, busy: false });
    await released;
    expect(h.pool.stats().runners[0]?.sessions).toBe(0);

    await vi.advanceTimersByTimeAsync(IDLE_REAP_MS * 2);
    expect(h.children[0]!.killed).toContain('SIGTERM');
    h.children[0]!.die(0, 'SIGTERM'); // the child exits in response, as a real one does
    await vi.advanceTimersByTimeAsync(1);
    const after = h.pool.stats();
    expect(after.runners).toHaveLength(0);
    expect(after.runners.reduce((n, r) => n + r.sessions, 0)).toBe(0);
    h.pool.reset('test over');
  });
});

describe('SubagentRunnerPool — reset is a teardown, not a kill switch', () => {
  // `reset` is what a PLUGIN RELOAD calls, at runtime, on a daemon that keeps serving. A pool that stayed
  // dead afterwards would quietly push every delegation back in-process until the next restart — which is
  // exactly what the single runner it replaced did NOT do.
  it('comes back on the next delegated turn after a plugin reload', async () => {
    const h = poolWith();
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    expect(h.pool.stats().runners).toHaveLength(1);

    h.pool.reset('plugins reloaded');
    h.children[0]!.die(0, 'SIGTERM');
    await expect(run).rejects.toThrow('interrupted');
    expect(h.pool.stats().runners).toHaveLength(0);
    expect(h.pool.usable()).toBe(true); // cleared, NOT disabled

    // The next turn cold-starts a fresh runner against the reloaded build.
    const again = fire(h.pool.run(request('subagent-sub-dlg-2', 'brain-2'), 'after reload'));
    await settle();
    expect(h.children).toHaveLength(2);
    h.children[1]!.boot();
    await settle();
    expect(h.children[1]!.turns().map((t) => t.text)).toEqual(['after reload']);
    h.children[1]!.finish(h.children[1]!.turns()[0]!.turnId, 'reloaded');
    expect(await again).toBe('reloaded');
    h.pool.reset('test over');
  });

  // A runner still booting when the reload lands was forked from the OLD build. Letting it join would put
  // a stale-build child back into service — the exact skew the build-id handshake exists to refuse.
  it('discards a runner that was still booting when the reset landed', async () => {
    const h = poolWith();
    const run = fire(h.pool.run(request('subagent-sub-dlg-1'), 'first'));
    await settle();
    expect(h.children).toHaveLength(1);
    h.pool.reset('plugins reloaded'); // mid-boot: the handshake has not completed
    h.children[0]!.boot();
    await settle();
    await expect(run).rejects.toBeInstanceOf(SubagentRunnerUnavailable);
    expect(h.children[0]!.killed).toContain('SIGTERM');
    expect(h.pool.stats().runners).toHaveLength(0);
  });
});

describe('SubagentRunnerPool — what /health shows', () => {
  it('reports the sizing, the per-runner state and the queue', async () => {
    const h = poolWith({ machine: machine(16, 64) });
    const { run } = await coldStart(h, 'subagent-sub-dlg-1');
    h.children[0]!.reply({ type: 'heartbeat', loopP99Ms: 42, activeTurns: 1, sessions: 1, rssBytes: 300 * 1024 * 1024 });
    await settle(1);
    const s = h.pool.stats();
    expect(s.mode).toBe('runner');
    expect(s.cap).toBe(15);
    expect(s.cpuCap).toBe(15);
    expect(s.queueDepth).toBe(0);
    expect(s.oldestQueuedMs).toBe(0);
    expect(s.runners).toHaveLength(1);
    expect(s.runners[0]).toMatchObject({ sessions: 1, activeTurns: 1, loopP99Ms: 42, rssBytes: 300 * 1024 * 1024 });
    // The estimate is replaced by what the runner actually reported.
    expect(s.measuredRunnerRss).toBe(true);
    expect(s.runnerRssBytes).toBe(300 * 1024 * 1024);
    void run;
    h.pool.reset('test over');
  });
});

/** A runner that connected every configured MCP server at boot launched its OWN server process tree — in
 *  production a whole Chrome per runner, invisible to the RSS-based sizing above. The pool hands the child
 *  the daemon's bridged tool DEFINITIONS instead, so the child declares the same tools and connects
 *  nothing until a tool is actually called. */
describe('SubagentRunnerPool — the bridged MCP snapshot the fork carries', () => {
  const snapshot: McpBridgeSnapshot = [{ serverName: 'parity', tools: [{ name: 'echo_text', description: 'Echo it' }] }];

  it('reads the snapshot at SPAWN time and sends it in the boot frame', async () => {
    const h = poolWith({ mcpBridgeSnapshot: () => Promise.resolve(snapshot) });
    const { run } = await coldStart(h);
    expect(bootFrame(h.children[0]!)?.mcp).toEqual(snapshot);
    void run;
    h.pool.reset('test over');
  });

  it('re-reads it for EVERY fork, so a runner mirrors the registry as it stands at that moment', async () => {
    // Not cached anywhere — that is the design. An MCP server the operator added or removed since the
    // daemon booted needs no invalidation, because nothing about it is remembered between forks.
    let generation = 0;
    const h = poolWith({
      mcpBridgeSnapshot: () => { generation += 1; return Promise.resolve([{ serverName: `gen-${generation}`, tools: [] }]); },
    });
    const { run } = await coldStart(h);
    expect(bootFrame(h.children[0]!)?.mcp).toEqual([{ serverName: 'gen-1', tools: [] }]);
    // Lose the runner; the next turn cold-starts a fresh one, which must be handed a FRESH snapshot.
    h.children[0]!.die();
    await settle();
    const second = fire(h.pool.run(request('subagent-sub-dlg-2', 'brain-2'), 'after the death'));
    await settle();
    h.children[1]?.boot();
    await settle();
    expect(h.children).toHaveLength(2);
    expect(bootFrame(h.children[1]!)?.mcp).toEqual([{ serverName: 'gen-2', tools: [] }]);
    void run; void second;
    h.pool.reset('test over');
  });

  it('forks WITHOUT a snapshot when there is none to be had, rather than failing the turn', async () => {
    // Fail-open on purpose: a snapshot we could not obtain must never be the reason a delegated turn has
    // no runner. The child then connects its servers itself — the old, slower boot, not a broken one.
    const h = poolWith({ mcpBridgeSnapshot: () => Promise.reject(new Error('the plugin registry will not load')) });
    const { run } = await coldStart(h);
    const frame = bootFrame(h.children[0]!);
    expect(frame).toBeTruthy();
    expect(frame && 'mcp' in frame).toBe(false);
    const [turn] = h.children[0]!.turns();
    expect(turn?.text).toBe('first');
    void run;
    h.pool.reset('test over');
  });
});
