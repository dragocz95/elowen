import { describe, it, expect, afterEach, vi } from 'vitest';
import { installGracefulShutdown, RESTART_EXIT_CODE } from '../../src/daemon/bootstrap.js';
import type { BrainService, PauseSummary } from '../../src/brain/brainService.js';

/** A scripted brain for the shutdown handler: what the pause checkpoint reports, and what the handler is
 *  allowed to touch around it. `reads` counts busy() calls — the pause must never poll it. */
const summary = (partial: Partial<PauseSummary> = {}): PauseSummary =>
  ({ turns: 0, children: 0, parked: [], queued: 0, unparkable: [], ...partial });
const scriptedBrain = (opts: {
  pause?: () => PauseSummary; settle?: (ids: readonly string[]) => Promise<string[]>;
  sent?: string[]; notices?: unknown[]; order?: string[]; shutdownServices?: () => Promise<void>;
} = {}) => {
  const state = { reads: 0 };
  const brain = ({
    busy: () => { state.reads += 1; return { turns: 0, children: 0, undelivered: 0 }; },
    beginDrain: () => { opts.order?.push('beginDrain'); },
    pauseForRestart: () => { opts.order?.push('checkpoint'); return opts.pause ? opts.pause() : summary(); },
    settleUnparkable: async (ids: readonly string[]) => { opts.order?.push(`wait:${ids.join(',')}`); return opts.settle ? opts.settle(ids) : [...ids]; },
    ...(opts.shutdownServices ? { shutdownPluginServices: async () => { opts.order?.push('stop-services'); await opts.shutdownServices!(); } } : {}),
    notify: async (text: string, _channelId?: string, notice?: unknown) => { opts.sent?.push(text); opts.notices?.push(notice); },
  }) as unknown as BrainService;
  return { brain, state };
};

const silentLog = { info: () => { /* quiet */ }, error: () => { /* quiet */ } };

/** Install, raise the signal (or request a restart), and resolve once the handler has called exit. */
async function run(
  brain: BrainService | undefined,
  trigger: 'SIGTERM' | 'SIGINT' | 'restart' = 'SIGTERM',
  opts: { notify?: boolean; order?: string[] } = {},
): Promise<{ exited: number[]; elapsedMs: number }> {
  const exited: number[] = [];
  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const control = installGracefulShutdown(brain, silentLog, {
      notify: opts.notify ?? false,
      exit: ((code: number) => { exited.push(code); opts.order?.push('exit'); resolve(); }) as never,
    });
    if (trigger === 'restart') control.requestRestart('test');
    else process.emit(trigger);
  });
  return { exited, elapsedMs: Date.now() - startedAt };
}

describe('the shutdown is a PAUSE: checkpoint, then exit within seconds', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  it('does not wait for a running turn or sub-agent: it checkpoints and exits at once', async () => {
    // The exact regression: a restart with a sub-agent in flight took a median of four minutes to exit
    // (a fifth of them a full ten-minute budget). Here the work NEVER finishes, and the exit still comes
    // right away — no loop waits on busy().
    const { brain, state } = scriptedBrain({ pause: () => summary({ turns: 3, children: 2, parked: ['brain-1'] }) });
    const { exited, elapsedMs } = await run(brain);
    expect(exited).toEqual([0]);
    expect(state.reads).toBe(0);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('checkpoints through the brain, then stops plugin services, then exits — in that order', async () => {
    const order: string[] = [];
    const { brain } = scriptedBrain({ order, pause: () => summary({ turns: 1, parked: ['brain-1'] }), shutdownServices: async () => {} });
    await run(brain, 'SIGTERM', { order });
    // The brain latches admission inside pauseForRestart itself; the handler never calls beginDrain.
    expect(order).toEqual(['checkpoint', 'stop-services', 'exit']);
  });

  it('gives the turns nothing can resume exactly one bounded wait, between the checkpoint and the exit', async () => {
    const order: string[] = [];
    const { brain } = scriptedBrain({
      order, pause: () => summary({ turns: 2, parked: ['brain-1'], unparkable: ['brain-ch-cron-x'] }), shutdownServices: async () => {},
    });
    const { exited } = await run(brain, 'SIGTERM', { order });
    expect(order).toEqual(['checkpoint', 'wait:brain-ch-cron-x', 'stop-services', 'exit']);
    expect(exited).toEqual([0]);
  });

  it('skips the wait entirely when every turn parked', async () => {
    const order: string[] = [];
    const { brain } = scriptedBrain({ order, pause: () => summary({ turns: 1, parked: ['brain-1'] }) });
    await run(brain, 'SIGTERM', { order });
    expect(order).toEqual(['checkpoint', 'exit']);
  });

  it('a requested restart pauses too and exits with the restart status', async () => {
    const { brain } = scriptedBrain({ pause: () => summary({ turns: 1, children: 1 }) });
    expect((await run(brain, 'restart')).exited).toEqual([RESTART_EXIT_CODE]);
  });

  it('keeps the restart status when someone signals again mid-pause', async () => {
    // Losing patience must not turn a restart into a stop: the impatient path has to reproduce the
    // decision already taken, or the daemon would pause and then stay down.
    const { brain } = scriptedBrain({
      pause: () => summary({ unparkable: ['brain-ch-cron-x'] }),
      settle: () => new Promise<string[]>(() => { /* wedged */ }),
    });
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      const control = installGracefulShutdown(brain, silentLog, {
        notify: false, exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      control.requestRestart('test');
      setTimeout(() => process.emit('SIGTERM'), 10); // impatient operator
    });
    expect(exited[0]).toBe(RESTART_EXIT_CODE);
  });

  it('pauses on SIGINT too, so an interactive Ctrl-C is not a harder kill than a deploy', async () => {
    const order: string[] = [];
    const { brain } = scriptedBrain({ order });
    expect((await run(brain, 'SIGINT', { order })).exited).toEqual([0]);
    expect(order).toContain('checkpoint');
  });

  it('a bounded plugin teardown cannot hold the pause: a wedged service is abandoned within the budget', async () => {
    const { brain } = scriptedBrain({ shutdownServices: () => new Promise<void>(() => { /* never resolves */ }) });
    const { exited, elapsedMs } = await run(brain);
    expect(exited).toEqual([0]);
    expect(elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  it('a wedged un-parkable wait cannot hold the process: the guard exits', async () => {
    const { brain } = scriptedBrain({
      pause: () => summary({ unparkable: ['brain-ch-cron-x'] }),
      settle: () => new Promise<string[]>(() => { /* never */ }),
    });
    const exited: number[] = [];
    vi.useFakeTimers();
    try {
      installGracefulShutdown(brain, silentLog, { notify: false, exit: ((code: number) => { exited.push(code); }) as never });
      process.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(27_000);
    } finally {
      vi.useRealTimers();
    }
    expect(exited).toEqual([0]);
  });

  it('a failing checkpoint is logged and the process still leaves instead of hanging until SIGKILL', async () => {
    const errors: string[] = [];
    const { brain } = scriptedBrain({ pause: () => { throw new Error('disk full'); } });
    const exited: number[] = [];
    await new Promise<void>((resolve) => {
      installGracefulShutdown(brain, { info: () => { /* quiet */ }, error: (m) => { errors.push(m); } }, {
        notify: false, exit: ((code: number) => { exited.push(code); resolve(); }) as never,
      });
      process.emit('SIGTERM');
    });
    expect(exited).toEqual([0]);
    expect(errors.some((m) => m.includes('pause checkpoint failed'))).toBe(true);
  });

  it('tolerates a brain without the pause seam (minimal test daemons) and having no brain at all', async () => {
    const bare = ({ busy: () => ({ turns: 0, children: 0, undelivered: 0 }), beginDrain: () => {}, notify: async () => {} }) as unknown as BrainService;
    expect((await run(bare)).exited).toEqual([0]);
    expect((await run(undefined)).exited).toEqual([0]);
  });
});

describe('the pause announces itself on the platforms', () => {
  afterEach(() => { process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT'); });

  it('says what was checkpointed, so the stop is visible where only the boot used to be', async () => {
    const sent: string[] = [];
    const notices: unknown[] = [];
    const { brain } = scriptedBrain({ sent, notices, pause: () => summary({ turns: 2, children: 1, parked: ['brain-1'] }) });
    await run(brain, 'SIGTERM', { notify: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Pausing');
    expect(sent[0]).toContain('2 turn(s)');
    expect(sent[0]).toContain('1 sub-agent(s)');
    // Named, so an adapter can translate it.
    expect(notices[0]).toEqual({ key: 'pausing', args: [2, 1] });
  });

  it('announces a plain restart when idle', async () => {
    const sent: string[] = [];
    const { brain } = scriptedBrain({ sent });
    await run(brain, 'SIGTERM', { notify: true });
    expect(sent).toEqual([expect.stringContaining('nothing was in flight')]);
  });

  it('a requested restart adds no second notice: restartHandler already announced it', async () => {
    const sent: string[] = [];
    const { brain } = scriptedBrain({ sent, pause: () => summary({ turns: 1 }) });
    await run(brain, 'restart', { notify: true });
    expect(sent).toEqual([]);
  });

  it('exits even when the announcement fails — a chat outage must not strand the process', async () => {
    const brain = ({
      busy: () => ({ turns: 0, children: 0, undelivered: 0 }),
      beginDrain: () => {},
      pauseForRestart: () => summary(),
      notify: async () => { throw new Error('discord down'); },
    }) as unknown as BrainService;
    expect((await run(brain, 'SIGTERM', { notify: true })).exited).toEqual([0]);
  });
});
