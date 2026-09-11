import { describe, it, expect } from 'vitest';
import {
  ESTIMATED_RUNNER_RSS_BYTES,
  GROWTH_COOLDOWN_MS,
  IDLE_REAP_MS,
  MAX_TURNS_PER_RUNNER,
  SATURATED_BEATS,
  SATURATING_TURNS,
  canAffordSpawn,
  isReapable,
  isSaturated,
  poolSizing,
  resolvePoolMax,
  shouldGrow,
  type MachineInputs,
} from '../../src/subagent/sizing.js';

const GB = 1024 ** 3;

/** A machine the test invents. The daemon must size itself correctly on hardware the suite will never
 *  run on — a 2-core VPS, a 64-core server — so every input arrives through this. */
const machine = (cores: number, totalGB: number, availGB = totalGB * 0.8): MachineInputs => ({
  cpus: () => cores,
  totalMemBytes: () => totalGB * GB,
  availableMemBytes: () => availGB * GB,
});

describe('pool sizing — the cap is measured, never hard-coded', () => {
  // One core: the daemon still gets a runner, because moving delegated work OFF the only event loop is
  // worth more on a single-core box than anywhere else.
  it('gives a 1-core machine exactly one runner', () => {
    expect(poolSizing(machine(1, 8)).cpuCap).toBe(1);
    expect(poolSizing(machine(1, 8)).cap).toBe(1);
  });

  it('leaves the daemon a core on a 2-core VPS', () => {
    const s = poolSizing(machine(2, 4));
    expect(s.cpuCap).toBe(1);
    expect(s.cap).toBe(1);
  });

  it('scales to 15 on a 16-core box with memory to spare', () => {
    const s = poolSizing(machine(16, 64));
    expect(s.cpuCap).toBe(15);
    expect(s.cap).toBe(15); // CPU binds; 64 GB would hold far more
    expect(s.memCap).toBeGreaterThan(s.cpuCap);
  });

  // The case the CPU rule alone gets wrong: plenty of cores, not enough RAM to give each one a runner.
  it('lets MEMORY bind on a 64-core box with only 32 GB', () => {
    const s = poolSizing(machine(64, 32));
    expect(s.cpuCap).toBe(63);
    expect(s.memCap).toBe(Math.floor((32 * GB * 0.5) / ESTIMATED_RUNNER_RSS_BYTES));
    expect(s.cap).toBe(s.memCap);
    expect(s.cap).toBeLessThan(s.cpuCap);
  });

  it('refuses to spawn at all on a box that cannot hold one runner', () => {
    // 512 MB total: half the budget is 256 MB, less than one runner. Zero is the honest answer — the
    // dispatcher then keeps every delegated turn in-process rather than forking into the OOM killer.
    expect(poolSizing(machine(4, 0.5)).cap).toBe(0);
  });

  it('replaces the conservative estimate with a runner’s measured size', () => {
    const estimated = poolSizing(machine(64, 32));
    const measured = poolSizing(machine(64, 32), { measuredRunnerRssBytes: 200 * 1024 * 1024 });
    expect(measured.runnerRssBytes).toBe(200 * 1024 * 1024);
    expect(estimated.runnerRssBytes).toBe(ESTIMATED_RUNNER_RSS_BYTES);
    // A runner smaller than the guess means MORE of them fit — the whole reason for measuring.
    expect(measured.memCap).toBeGreaterThan(estimated.memCap);
  });

  describe('the operator knob, for machines whose own numbers lie', () => {
    // A container with a 0.5 CPU cfs quota and a 1 GB memory limit: availableParallelism() reports the
    // HOST's 64 cores and totalmem() the HOST's 128 GB, so every machine input here is a lie. The knob is
    // the only thing that can be right.
    const lyingCgroup = machine(64, 128);

    it('narrows a cap the machine reported far too high', () => {
      expect(poolSizing(lyingCgroup).cap).toBe(63);
      const capped = poolSizing(lyingCgroup, { operatorMax: 1 });
      expect(capped.cap).toBe(1);
      expect(capped.operatorCapped).toBe(true);
    });

    it('disables the pool entirely at 0', () => {
      expect(poolSizing(lyingCgroup, { operatorMax: 0 }).cap).toBe(0);
    });

    it('sizes from the machine when the knob is auto', () => {
      expect(poolSizing(lyingCgroup, { operatorMax: null }).operatorCapped).toBe(false);
    });

    it('lets an explicit operator cap oversubscribe CPU but never memory', () => {
      const s = poolSizing(machine(2, 4), { operatorMax: 99 });
      expect(s.cpuCap).toBe(1);
      expect(s.cap).toBe(s.memCap);
      expect(s.cap).toBeGreaterThan(s.cpuCap);
      expect(s.operatorCapped).toBe(false);
    });

    it('uses an explicit cap above the CPU ceiling when memory can hold it', () => {
      const s = poolSizing(machine(16, 64), { operatorMax: 50 });
      expect(s.cpuCap).toBe(15);
      expect(s.memCap).toBeGreaterThanOrEqual(50);
      expect(s.cap).toBe(50);
      expect(s.operatorCapped).toBe(true);
    });
  });

  describe('the env override', () => {
    it('wins over the stored setting — a lying container is fixed at deploy time, not by a DB write', () => {
      expect(resolvePoolMax(8, '2')).toBe(2);
      expect(resolvePoolMax(null, '0')).toBe(0);
    });

    it('falls through to the setting when unset, blank or not a number', () => {
      expect(resolvePoolMax(4, undefined)).toBe(4);
      expect(resolvePoolMax(4, '  ')).toBe(4);
      expect(resolvePoolMax(4, 'lots')).toBe(4);
      expect(resolvePoolMax(4, '-1')).toBe(4);
    });

    it('defaults to auto with neither set', () => {
      expect(resolvePoolMax(undefined, undefined)).toBeNull();
    });
  });

  describe('free memory gates the individual spawn', () => {
    it('denies a spawn the box could not currently cover, however high the cap', () => {
      // 64 cores, 128 GB total (cap 63) but almost nothing actually available right now.
      const squeezed = machine(64, 128, 0.2);
      expect(poolSizing(squeezed).cap).toBe(63);
      expect(canAffordSpawn(squeezed, ESTIMATED_RUNNER_RSS_BYTES)).toBe(false);
    });

    it('allows one when there is headroom above the steady-state size', () => {
      expect(canAffordSpawn(machine(8, 32, 16), ESTIMATED_RUNNER_RSS_BYTES)).toBe(true);
    });
  });
});

describe('saturation — sustained evidence, not a spike', () => {
  it('is never true for a runner with no work, whatever its loop reports', () => {
    expect(isSaturated({ activeTurns: 0, saturatedBeats: 999 })).toBe(false);
  });

  it('ignores a single bad beat', () => {
    expect(isSaturated({ activeTurns: 1, saturatedBeats: SATURATED_BEATS - 1 })).toBe(false);
  });

  it('accepts a streak', () => {
    expect(isSaturated({ activeTurns: 1, saturatedBeats: SATURATED_BEATS })).toBe(true);
  });

  // A delegated turn is mostly AWAITING the provider, so a contended runner can still show a quiet loop.
  it('counts concurrent turns even on a perfectly quiet loop', () => {
    expect(isSaturated({ activeTurns: SATURATING_TURNS, saturatedBeats: 0 })).toBe(true);
  });

  // The pool must reach for another runner BEFORE it starts making turns wait.
  it('saturates below the admission limit, so growth is tried before queueing', () => {
    expect(SATURATING_TURNS).toBeLessThan(MAX_TURNS_PER_RUNNER);
  });
});

describe('reaping', () => {
  it('needs empty, unrouted and idle all at once', () => {
    expect(isReapable({ activeTurns: 0, routedSessions: 0, idleMs: IDLE_REAP_MS })).toBe(true);
    expect(isReapable({ activeTurns: 1, routedSessions: 0, idleMs: IDLE_REAP_MS })).toBe(false);
    // A routed session is a promise that the channel lives in THIS process; reaping would break it.
    expect(isReapable({ activeTurns: 0, routedSessions: 1, idleMs: IDLE_REAP_MS })).toBe(false);
    expect(isReapable({ activeTurns: 0, routedSessions: 0, idleMs: IDLE_REAP_MS - 1 })).toBe(false);
  });

  // The load-bearing half of the anti-flapping argument, asserted rather than merely asserted-in-a-comment.
  it('is provably disjoint from saturation across the whole input space', () => {
    for (let turns = 0; turns <= 12; turns += 1) {
      for (let beats = 0; beats <= 6; beats += 1) {
        for (const routed of [0, 1, 3]) {
          for (const idle of [0, IDLE_REAP_MS - 1, IDLE_REAP_MS, IDLE_REAP_MS * 10]) {
            const saturated = isSaturated({ activeTurns: turns, saturatedBeats: beats });
            const reapable = isReapable({ activeTurns: turns, routedSessions: routed, idleMs: idle });
            expect(saturated && reapable).toBe(false);
          }
        }
      }
    }
  });
});

describe('the growth decision', () => {
  const base = {
    runners: [{ activeTurns: MAX_TURNS_PER_RUNNER, saturatedBeats: SATURATED_BEATS }],
    pressure: true,
    cap: 4,
    sinceLastSpawnMs: GROWTH_COOLDOWN_MS,
    memoryAllows: true,
  };
  const grow = (o: Partial<typeof base> = {}): boolean => shouldGrow({ ...base, ...o });

  it('grows on the full case', () => { expect(grow()).toBe(true); });
  it('does not grow with nothing waiting', () => { expect(grow({ pressure: false })).toBe(false); });
  it('does not grow while some runner still has slack', () => {
    expect(grow({ runners: [...base.runners, { activeTurns: 0, saturatedBeats: 0 }] })).toBe(false);
  });
  it('never exceeds the cap', () => {
    expect(grow({ cap: 1 })).toBe(false);
    expect(grow({ cap: 0 })).toBe(false);
  });
  it('holds a burst behind the cooldown', () => {
    expect(grow({ sinceLastSpawnMs: GROWTH_COOLDOWN_MS - 1 })).toBe(false);
  });
  it('refuses when the box could not cover another runner', () => {
    expect(grow({ memoryAllows: false })).toBe(false);
  });
  // A cold start is the dispatcher's business: it must be able to report "unavailable" and fall back
  // in-process, which an unbounded wait for a spawn decision would take away from it.
  it('is not what starts the first runner', () => { expect(grow({ runners: [] })).toBe(false); });
});

describe('no flapping — thousands of simulated heartbeats', () => {
  /** The pool's own state machine, driven by scripted load. Runs the REAL predicates, so the property
   *  under test is the shipped logic and not a paraphrase of it. */
  it('never spawns and reaps in the same tick, and settles instead of oscillating', () => {
    const cap = poolSizing(machine(16, 64)).cap;
    interface Sim { activeTurns: number; saturatedBeats: number; idleMs: number; routed: number }
    let runners: Sim[] = [{ activeTurns: 0, saturatedBeats: 0, idleMs: 0, routed: 0 }];
    let sinceSpawn = GROWTH_COOLDOWN_MS;
    let spawns = 0;
    let reaps = 0;
    let queue = 0;
    // A deterministic pseudo-random walk: bursts of demand, then quiet, repeatedly — the shape that would
    // make a naive pool oscillate. Seeded so a failure is reproducible.
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };

    for (let beat = 0; beat < 5_000; beat += 1) {
      const busyPhase = Math.floor(beat / 250) % 2 === 0;
      // Demand arrives and drains.
      for (const r of runners) {
        const want = busyPhase ? Math.round(rnd() * MAX_TURNS_PER_RUNNER) : 0;
        r.activeTurns = want;
        r.routed = want > 0 ? 1 : 0;
        r.saturatedBeats = busyPhase && rnd() > 0.3 ? r.saturatedBeats + 1 : 0;
        r.idleMs = want === 0 ? r.idleMs + 2_000 : 0;
      }
      queue = busyPhase && runners.every((r) => r.activeTurns >= MAX_TURNS_PER_RUNNER) ? queue + 1 : 0;

      const grow = shouldGrow({
        runners: runners.map((r) => ({ activeTurns: r.activeTurns, saturatedBeats: r.saturatedBeats })),
        pressure: queue > 0,
        cap,
        sinceLastSpawnMs: sinceSpawn,
        memoryAllows: true,
      });
      const reapable = runners.filter((r) => isReapable({ activeTurns: r.activeTurns, routedSessions: r.routed, idleMs: r.idleMs }));

      // THE property: the pool is never simultaneously told to add and to remove a runner.
      expect(grow && reapable.length > 0).toBe(false);

      if (grow) {
        runners.push({ activeTurns: 0, saturatedBeats: 0, idleMs: 0, routed: 0 });
        spawns += 1;
        sinceSpawn = 0;
      } else {
        sinceSpawn += 2_000;
      }
      if (reapable.length > 0) {
        runners = runners.filter((r) => !reapable.includes(r));
        reaps += reapable.length;
        if (runners.length === 0) runners.push({ activeTurns: 0, saturatedBeats: 0, idleMs: 0, routed: 0 });
      }
      expect(runners.length).toBeLessThanOrEqual(cap);
    }

    // 5000 beats is ~2.8 hours of wall clock at a 2 s heartbeat, across 10 busy/quiet cycles. A flapping
    // pool would spawn and reap on the order of once per beat; a stable one acts a handful of times per
    // cycle. The bound is deliberately loose — the assertion is "orders of magnitude below flapping".
    expect(spawns).toBeLessThan(120);
    expect(reaps).toBeLessThan(120);
  });
});
