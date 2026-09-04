import { describe, it, expect, afterEach, vi } from 'vitest';
import { installGracefulShutdown, RESTART_EXIT_CODE } from '../../src/daemon/bootstrap.js';
import { resolveShutdownMode } from '../../src/daemon/shutdown.js';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainService } from '../../src/brain/brainService.js';
import { StepDrainCoordinator } from '../../src/brain/stepDrain.js';

/** A brain whose in-flight work follows a scripted sequence, one entry consumed per busy() call. The last
 *  entry repeats, so a test can end on "still busy" to exercise the budget expiring.
 *
 *  `reads` counts busy() calls, which is what actually proves the handler WAITED: asserting only on the
 *  exit code passes just as happily when the wait loop is deleted entirely. */
type Busy = { turns: number; children: number; undelivered?: number };
const brainBusy = (sequence: Busy[], sent?: string[], notices?: unknown[]) => {
  const state = { reads: 0 };
  const brain = ({
    busy: () => ({ undelivered: 0, ...sequence[Math.min(state.reads++, sequence.length - 1)] }),
    beginDrain: () => { /* real BrainService latches its admission gate here */ },
    notify: async (text: string, _channelId?: string, notice?: unknown) => { sent?.push(text); notices?.push(notice); },
  }) as unknown as BrainService;
  return { brain, state };
};

const silentLog = { info: () => { /* quiet */ }, error: () => { /* quiet */ } };
/** The describe blocks below pin the STEP-BOUNDARY DRAIN, which is now the explicit, opt-in shutdown
 *  (`elowen restart --drain`); the default pause has its own block at the bottom of this file. */
const drainMode = () => 'drain' as const;

describe('a requested restart drains like a stop but exits for the supervisor to start again', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  /** Install, ask for a restart, and resolve once the handler has called exit. */
  const runRestart = async (brain: BrainService, after?: () => void) => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      const control = installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      control.requestRestart('test');
      after?.();
    });
    return exited;
  };

  it('exits with the reserved restart status rather than a clean stop', async () => {
    const { brain } = brainBusy([{ turns: 0, children: 0 }]);
    // 75 is what the unit pins with RestartForceExitStatus. Exiting 0 here would drain correctly and then
    // leave the daemon stopped, which is the one outcome a restart must never produce.
    expect(await runRestart(brain)).toEqual([RESTART_EXIT_CODE]);
  });

  it('waits for a running turn before exiting, exactly like a stop', async () => {
    const { brain, state } = brainBusy([
      { turns: 1, children: 0 }, { turns: 1, children: 0 }, { turns: 0, children: 0 },
    ]);
    expect(await runRestart(brain)).toEqual([RESTART_EXIT_CODE]);
    expect(state.reads).toBeGreaterThan(2); // it polled rather than exiting on the first look
  });

  it('keeps the restart status when someone signals again mid-drain', async () => {
    // Losing patience must not turn a restart into a stop: the impatient path has to reproduce the
    // decision already taken, or the daemon would drain and then stay down.
    const { brain } = brainBusy([{ turns: 1, children: 0 }]);
    const codes = await runRestart(brain, () => { process.emit('SIGTERM'); });
    expect(codes[0]).toBe(RESTART_EXIT_CODE);
  });

  it('does not burn the whole budget on a result nobody can receive', async () => {
    // The regression this fixes: delivery marks a result `acknowledged` only once it reaches the parent's
    // transcript, which needs another turn — and the drain refuses new turns. An orphan (parent is a
    // sub-agent that already finished) therefore never clears, and it is counted globally, so EVERY
    // restart waited the full ten minutes. Here the count never drops and the drain must still exit.
    const { brain, state } = brainBusy([{ turns: 0, children: 0, undelivered: 1 }]);
    const exited: number[] = [];
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 60_000, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
    // Well inside the 10 s grace, and nowhere near the 60 s budget it used to consume.
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    expect(state.reads).toBeGreaterThan(1); // it did look more than once before giving up
  }, 40_000);

  it('still exits 0 for an ordinary stop, so a deliberate stop stays stopped', async () => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brainBusy([{ turns: 0, children: 0 }]).brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
  });
});

describe('installGracefulShutdown — a stop waits for running work instead of cutting it off', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  /** Install, raise the signal, and resolve once the handler has called exit. */
  const runSignal = async (brain: BrainService, opts?: Parameters<typeof installGracefulShutdown>[2]) => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false, mode: drainMode, ...opts,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    return exited;
  };

  it('exits immediately when nothing is running', async () => {
    const { brain, state } = brainBusy([{ turns: 0, children: 0 }]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(2); // the announcement's read + one loop check that found it idle
  });

  it('stops plugin services after the turn drain and before process exit', async () => {
    const order: string[] = [];
    const brain = ({
      busy: () => ({ turns: 0, children: 0, undelivered: 0 }),
      notify: async () => { /* quiet */ },
      beginDrain: () => order.push('begin-drain'),
      shutdownPluginServices: async () => { order.push('stop-services'); },
    }) as unknown as BrainService;
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false, mode: drainMode,
        exit: ((code: number) => { order.push(`exit-${code}`); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(order).toEqual(['begin-drain', 'stop-services', 'exit-0']);
  });

  it('tells the brain to stop admitting new turns the moment draining starts', async () => {
    // Without this the drain waits on busy(), but fresh input keeps arriving through the window and can
    // hold busy() above zero for the full budget. The handler must latch the admission gate first.
    const drained: number[] = [];
    const brain = ({
      busy: () => ({ turns: 0, children: 0, undelivered: 0 }),
      notify: async () => { /* quiet */ },
      beginDrain: () => drained.push(Date.now()),
    }) as unknown as BrainService;
    await runSignal(brain);
    expect(drained).toHaveLength(1);
  });

  it('keeps re-checking until the running turn finishes, and only then exits', async () => {
    const { brain, state } = brainBusy([
      { turns: 1, children: 0 }, // the announcement's own read
      { turns: 1, children: 0 },
      { turns: 1, children: 0 },
      { turns: 0, children: 0 }, // turn finished
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    // The whole point: it polled until the work went away. Anything less means it exited mid-turn.
    expect(state.reads).toBe(4);
  });

  it('waits for a delegated sub-agent just as it waits for a turn', async () => {
    const { brain, state } = brainBusy([
      { turns: 0, children: 2 },
      { turns: 0, children: 1 },
      { turns: 0, children: 0 },
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(3);
  });

  // The regression Filip hit: the sub-agent had FINISHED, so turns and children both read zero, but its
  // answer had not yet reached the parent turn. Exiting there loses a completed delegation's result.
  it('waits for a finished sub-agent to actually hand its result to the parent', async () => {
    const { brain, state } = brainBusy([
      { turns: 0, children: 0, undelivered: 1 },
      { turns: 0, children: 0, undelivered: 1 },
      { turns: 0, children: 0, undelivered: 0 }, // parent turn took it
    ]);
    expect(await runSignal(brain)).toEqual([0]);
    expect(state.reads).toBe(3);
  });

  it('gives up and exits cleanly when the drain budget expires, rather than hanging until SIGKILL', async () => {
    // Never goes idle. systemd would SIGKILL at 90s, which is the outcome the drain exists to avoid, so
    // the budget has to end the wait on our own terms.
    const { brain } = brainBusy([{ turns: 1, children: 0 }]);
    const exited = await runSignal(brain, { drainMs: 20 });
    expect(exited).toEqual([0]); // clean: `Restart=on-failure` must not read a deliberate stop as a crash
  });

  it('exits on a second signal without finishing the wait', async () => {
    const exited: number[] = [];
    const { brain } = brainBusy([{ turns: 1, children: 0 }]); // would otherwise drain forever
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 5, drainMs: 60_000, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
      setTimeout(() => process.emit('SIGTERM'), 10); // impatient operator
    });
    expect(exited[0]).toBe(0);
  });

  it('exits at the STEP boundary while whole turns are still live, instead of burning the budget on them', async () => {
    // The step-boundary drain: busy() keeps reporting a live turn (it IS live — parked at its boundary),
    // but midStepWork() says nothing is mid-step, so leaving is safe (boot recovery resumes the turn from
    // its answered pending tail). Under the old whole-turn predicate this scenario waited the entire
    // 60 s budget — which is what made every deploy under a long agent turn a ten-minute outage.
    const midStepSequence = [1, 1, 0];
    let midStepReads = 0;
    const { brain, state } = brainBusy([{ turns: 1, children: 1 }]);
    (brain as unknown as { midStepWork: () => Promise<number> }).midStepWork =
      async () => midStepSequence[Math.min(midStepReads++, midStepSequence.length - 1)]!;
    const startedAt = Date.now();
    const exited = await runSignal(brain, { drainMs: 60_000 });
    expect(exited).toEqual([0]);
    expect(Date.now() - startedAt).toBeLessThan(30_000); // nowhere near the budget the old drain consumed
    expect(midStepReads).toBe(3); // it waited for the mid-step count, not for busy() to reach zero
    expect(state.reads).toBeGreaterThan(1);
  }, 40_000);

  it('still waits (and falls back to the budget) while a turn is genuinely mid-step', async () => {
    // A wedged model call or local tool never reaches its boundary; the full budget remains the fallback.
    const { brain } = brainBusy([{ turns: 1, children: 0 }]);
    (brain as unknown as { midStepWork: () => Promise<number> }).midStepWork = async () => 1;
    const exited = await runSignal(brain, { drainMs: 20 });
    expect(exited).toEqual([0]);
  });

  it('drives a REAL coordinator through the real drain loop: park on beginDrain, then exit', async () => {
    // The other step-boundary tests stub midStepWork; this one wires an actual StepDrainCoordinator with
    // an installed hold, so the loop is proven against the real park/latch mechanics: the turn is
    // mid-step until beginDrain latches the coordinator, its next boundary parks, and the drain exits.
    const drainCoord = new StepDrainCoordinator();
    const child = 'brain-ch-subagent-real-park';
    const agent: { prepareNextTurnWithContext?: (turn: unknown, signal?: AbortSignal) => Promise<unknown> } = {};
    drainCoord.installHold({ agent } as never, child);
    const brain = ({
      busy: () => ({ turns: 1, children: 0, undelivered: 0 }),
      beginDrain: () => {
        drainCoord.begin();
        // The agent loop reaches its next step boundary a moment later and parks there.
        setTimeout(() => { void agent.prepareNextTurnWithContext!({}, new AbortController().signal); }, 20);
      },
      midStepWork: async () => drainCoord.unsafeCount([child]),
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    const startedAt = Date.now();
    const exited = await runSignal(brain, { drainMs: 60_000, pollMs: 5 });
    expect(exited).toEqual([0]);
    expect(Date.now() - startedAt).toBeLessThan(30_000); // parked at the boundary, not the fallback budget
  }, 40_000);

  it('parks a long TOP-LEVEL owner turn at its boundary and exits in seconds, writing the durable marker', async () => {
    // The operator's exact question: a restart while an agent works in ANOTHER conversation must not
    // wait the 600 s fallback. An owner turn now parks like a sub-agent — its safety comes from the
    // durable park marker (onParked), which the boot resume sweep turns back into the finished answer.
    const marked: string[] = [];
    const drainCoord = new StepDrainCoordinator({ onParked: (id) => { marked.push(id); } });
    const owner = 'brain-1';
    const agent: { prepareNextTurnWithContext?: (turn: unknown, signal?: AbortSignal) => Promise<unknown> } = {};
    drainCoord.installHold({ agent } as never, owner);
    const brain = ({
      busy: () => ({ turns: 1, children: 0, undelivered: 0 }),
      beginDrain: () => {
        drainCoord.begin();
        // The long tool loop reaches its next step boundary a moment later and parks there.
        setTimeout(() => { void agent.prepareNextTurnWithContext!({}, new AbortController().signal); }, 20);
      },
      midStepWork: async () => drainCoord.unsafeCount([owner]),
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    const startedAt = Date.now();
    const exited = await runSignal(brain, { drainMs: 60_000, pollMs: 5 });
    expect(exited).toEqual([0]);
    expect(Date.now() - startedAt).toBeLessThan(30_000); // parked at the boundary, not the fallback budget
    expect(marked).toEqual([owner]); // the marker the boot resume needs was written before the exit
  }, 40_000);

  it('latches the step drain in the runner pool too (beginDrain reaches the brain exactly once)', async () => {
    // The daemon-side latch is what parks turns; BrainService.beginDrain also broadcasts to the pool.
    // Here we only pin that the shutdown handler calls it before polling — the broadcast itself is
    // BrainService wiring.
    const order: string[] = [];
    const brain = ({
      busy: () => ({ turns: 0, children: 0, undelivered: 0 }),
      beginDrain: () => order.push('beginDrain'),
      midStepWork: async () => { order.push('poll'); return 0; },
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    await runSignal(brain);
    expect(order[0]).toBe('beginDrain');
    expect(order).toContain('poll');
  });

  it('says what it is waiting for, so the stop is visible where only the boot used to be', async () => {
    const sent: string[] = [];
    const { brain } = brainBusy([{ turns: 2, children: 3 }, { turns: 0, children: 0 }], sent);
    await runSignal(brain, { notify: true });
    expect(sent[0]).toContain('2 turn(s)');
    expect(sent[0]).toContain('3 sub-agent(s)');
  });

  it('announces a plain stop when idle', async () => {
    const sent: string[] = [];
    await runSignal(brainBusy([{ turns: 0, children: 0 }], sent).brain, { notify: true });
    expect(sent[0]).toBe('🛑 **Stopping** — Elowen is shutting down.');
  });

  // The English text above is only half of what goes out: adapters translate from a descriptor naming
  // WHICH announcement this is. Send the text without it and nothing looks wrong — every assertion on the
  // wording still passes, while a Czech or Slovak instance quietly stays English for good.
  it('names the announcement so an adapter can translate it', async () => {
    const busyNotices: unknown[] = [];
    await runSignal(brainBusy([{ turns: 2, children: 3 }, { turns: 0, children: 0 }], [], busyNotices).brain, { notify: true });
    expect(busyNotices[0]).toEqual({ key: 'stopping', args: [2, 3, 0] });

    const idleNotices: unknown[] = [];
    await runSignal(brainBusy([{ turns: 0, children: 0 }], [], idleNotices).brain, { notify: true });
    expect(idleNotices[0]).toEqual({ key: 'stoppingIdle', args: [] });
  });

  it('exits even when the announcement fails — a chat outage must not strand the process', async () => {
    const brain = ({
      busy: () => ({ turns: 0, children: 0 }),
      beginDrain: () => { /* quiet */ },
      notify: async () => { throw new Error('discord is down'); },
    }) as unknown as BrainService;
    expect(await runSignal(brain, { notify: true })).toEqual([0]);
  });

  it('tolerates having no brain at all', async () => {
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(undefined, silentLog, {
        pollMs: 1, drainMs: 50, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
  });

  it('drains on SIGINT too, so an interactive Ctrl-C is not a harder kill than a deploy', async () => {
    const exited: number[] = [];
    const spy = vi.fn(() => ({ turns: 0, children: 0 }));
    const brain = ({ busy: spy, beginDrain: () => { /* quiet */ }, notify: async () => { /* quiet */ } }) as unknown as BrainService;
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 50, notify: false, mode: drainMode,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGINT');
    });
    expect(exited).toEqual([0]);
    expect(spy).toHaveBeenCalled();
  });
});

describe('the default shutdown is a PAUSE: checkpoint, then exit within seconds', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');
    delete process.env.ELOWEN_SHUTDOWN_MODE;
  });

  /** Install with the production mode resolution (env + marker), raise the signal, resolve on exit. */
  const runSignal = async (brain: BrainService | undefined, marker?: string) => {
    const exited: number[] = [];
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, silentLog, {
        pollMs: 5, drainMs: 60_000, notify: false,
        mode: () => resolveShutdownMode(process.env, marker),
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    return { exited, elapsedMs: Date.now() - startedAt };
  };

  it('does not wait for a running turn or sub-agent: it checkpoints and exits at once', async () => {
    // The exact regression: a restart with a sub-agent in flight took a median of four minutes to exit
    // (a fifth of them the full ten-minute budget). Here the work NEVER finishes, and the exit still
    // comes right away — the drain loop is not entered at all.
    const { brain, state } = brainBusy([{ turns: 3, children: 2 }]);
    const paused: number[] = [];
    (brain as unknown as { pauseForRestart: () => unknown }).pauseForRestart = () => {
      paused.push(Date.now());
      return { turns: 3, children: 2, parked: ['brain-1'], queued: 0 };
    };
    const { exited, elapsedMs } = await runSignal(brain);
    expect(exited).toEqual([0]);
    expect(paused).toHaveLength(1);
    expect(state.reads).toBe(0); // never polled busy(): nothing was waited for
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('checkpoints through the brain BEFORE stopping plugin services, and never latches the drain loop', async () => {
    const order: string[] = [];
    const brain = ({
      busy: () => { order.push('busy'); return { turns: 1, children: 0, undelivered: 0 }; },
      beginDrain: () => order.push('beginDrain'),
      pauseForRestart: () => { order.push('pause'); return { turns: 1, children: 0, parked: [], queued: 0 }; },
      shutdownPluginServices: async () => { order.push('stop-services'); },
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    await runSignal(brain);
    // The real BrainService.pauseForRestart latches admission itself; the handler must not poll busy().
    expect(order).toEqual(['pause', 'stop-services']);
  });

  it('a requested restart pauses too and exits with the restart status', async () => {
    const { brain } = brainBusy([{ turns: 1, children: 1 }]);
    (brain as unknown as { pauseForRestart: () => unknown }).pauseForRestart =
      () => ({ turns: 1, children: 1, parked: [], queued: 0 });
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      const control = installGracefulShutdown(brain, silentLog, {
        pollMs: 5, drainMs: 60_000, notify: false,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      control.requestRestart('test');
    });
    expect(exited).toEqual([RESTART_EXIT_CODE]);
  });

  it('a requested restart may ask for a drain explicitly (`/restart drain`)', async () => {
    const { brain, state } = brainBusy([{ turns: 1, children: 0 }, { turns: 1, children: 0 }, { turns: 0, children: 0 }]);
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      const control = installGracefulShutdown(brain, silentLog, {
        pollMs: 1, drainMs: 200, notify: false,
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      control.requestRestart('test', { mode: 'drain' });
    });
    expect(exited).toEqual([RESTART_EXIT_CODE]);
    expect(state.reads).toBeGreaterThan(2); // it waited for the turn, drain-style
  });

  it('a bounded plugin teardown cannot hold the pause: a wedged service is abandoned within the budget', async () => {
    const brain = ({
      busy: () => ({ turns: 0, children: 0, undelivered: 0 }),
      beginDrain: () => { /* quiet */ },
      pauseForRestart: () => ({ turns: 0, children: 0, parked: [], queued: 0 }),
      shutdownPluginServices: () => new Promise<void>(() => { /* never resolves */ }),
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    const { exited, elapsedMs } = await runSignal(brain);
    expect(exited).toEqual([0]);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it('the one-shot drain marker turns exactly ONE shutdown into a drain and is consumed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shutdown-'));
    const marker = join(dir, '.shutdown-drain');
    writeFileSync(marker, String(Date.now()));
    try {
      expect(resolveShutdownMode({}, marker)).toBe('drain');
      expect(existsSync(marker)).toBe(false); // consumed
      expect(resolveShutdownMode({}, marker)).toBe('pause'); // the next restart is a pause again
      expect(resolveShutdownMode({ ELOWEN_SHUTDOWN_MODE: 'drain' }, marker)).toBe('drain');
      expect(resolveShutdownMode({ ELOWEN_SHUTDOWN_MODE: 'anything-else' }, marker)).toBe('pause');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a signal with the drain marker present waits for the running turn (the opt-in still works end to end)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elowen-shutdown-'));
    const marker = join(dir, '.shutdown-drain');
    writeFileSync(marker, String(Date.now()));
    try {
      const { brain, state } = brainBusy([{ turns: 1, children: 0 }, { turns: 1, children: 0 }, { turns: 0, children: 0 }]);
      const { exited } = await runSignal(brain, marker);
      expect(exited).toEqual([0]);
      expect(state.reads).toBeGreaterThan(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates a brain without the pause seam (minimal test daemons) and having no brain at all', async () => {
    const { brain } = brainBusy([{ turns: 0, children: 0 }]);
    expect((await runSignal(brain)).exited).toEqual([0]);
    expect((await runSignal(undefined)).exited).toEqual([0]);
  });
});

describe('a pause whose checkpoint throws still exits', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  it('logs the failure and leaves instead of hanging until SIGKILL', async () => {
    const errors: string[] = [];
    const brain = ({
      busy: () => ({ turns: 1, children: 0, undelivered: 0 }),
      beginDrain: () => { /* quiet */ },
      pauseForRestart: () => { throw new Error('disk full'); },
      notify: async () => { /* quiet */ },
    }) as unknown as BrainService;
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, { info: () => { /* quiet */ }, error: (m) => { errors.push(m); } }, {
        pollMs: 5, drainMs: 60_000, notify: false, mode: () => 'pause',
        exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
    expect(errors.some((m) => m.includes('pause checkpoint failed'))).toBe(true);
  });
});
