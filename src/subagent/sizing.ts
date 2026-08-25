/** HOW BIG THE SUB-AGENT POOL MAY GET, AND WHEN IT IS ALLOWED TO GROW.
 *
 *  Deliberately pure and injectable: every machine input arrives through {@link MachineInputs} so the
 *  sizing rule can be exercised at 1, 2, 16 and 64 cores — and against a container whose reported inputs
 *  are lies — without the test having to run on such a box. The daemon must run unchanged on a 2-core VPS
 *  and on a 16-core server, which means nothing here may be a hard-coded count. */
import { availableParallelism, freemem, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';

/** The truthful-ish facts about the machine the pool sizes itself from. */
export interface MachineInputs {
  /** Schedulable CPUs. */
  cpus(): number;
  /** Total physical memory, in bytes. */
  totalMemBytes(): number;
  /** Memory that could actually be handed to a NEW process right now, in bytes. */
  availableMemBytes(): number;
}

/** A conservative first guess at one runner's resident size, used ONLY until a live runner reports its
 *  own. Calibrated against this build: the daemon process — a strict superset of a runner, since it also
 *  holds the HTTP server, the platform gateway, cron and other background services — sits around 0.8 GB RSS.
 *
 *  It errs HIGH on purpose. The estimate only ever DIVIDES the memory budget, so guessing high spawns
 *  fewer runners than the box could really hold (a performance cost), while guessing low is how a fan-out
 *  gets the daemon OOM-killed (a correctness cost). */
export const ESTIMATED_RUNNER_RSS_BYTES = 512 * 1024 * 1024;

/** Share of TOTAL memory the sub-agent pool may occupy. The other half is not spare: the daemon itself,
 *  its SQLite page cache, provider response buffers and whatever else the operator runs on the box all
 *  live there. Elowen must never be the reason a machine starts swapping. */
const MEM_BUDGET_FRACTION = 0.5;

/** A spawn must find this multiple of a runner's steady-state RSS genuinely available before it is
 *  allowed. 1.5 rather than 1.0 because the figure being multiplied is STEADY STATE: a booting runner
 *  transiently exceeds it while it parses modules, JITs and loads plugins, so a spawn that would fit
 *  exactly at rest does not fit at boot. Below this the turn packs onto an existing runner instead. */
const SPAWN_HEADROOM = 1.5;

/** Event-loop p99 above which a runner is over threshold FOR THIS BEAT.
 *
 *  Higher than the daemon's own 150 ms line (`SUSTAINED_P99_MS` in shared/eventLoopLag) on purpose: that
 *  number marks "the interactive CLI and web feel sluggish", and a runner has no interactive path to
 *  protect, so it may run hotter before we pay for a whole extra process (a cold plugin boot plus ~0.5 GB).
 *  250 ms is where a runner's own tool callbacks and stream reads start queueing behind each other. It is
 *  also two orders of magnitude above the sampler's 1 ms resolution floor, so it cannot be tripped by the
 *  measurement itself. */
export const SATURATION_P99_MS = 250;

/** How many CONSECUTIVE heartbeats must be over threshold before lag counts as saturation. One beat is a
 *  spike — a single large tool result parsed, a GC pause — and forking a process for a spike is exactly
 *  how a burst becomes a herd. Two beats is >= 4 s of evidence at {@link HEARTBEAT_INTERVAL_MS}.
 *
 *  The lag window is double-buffered (see shared/eventLoopLag): every beat reads between half and one
 *  full window of history, so a beat can no longer land on a freshly cleared histogram and break the
 *  streak by accident — the old single-buffer roll did exactly that and biased the pool against growing. */
export const SATURATED_BEATS = 2;

/** A runner already carrying this many concurrent turns counts as saturated whatever its loop reports.
 *  A delegated turn spends most of its wall time AWAITING the provider, so a genuinely contended runner
 *  can still show a quiet loop between responses — turn count is the pressure the lag number cannot see.
 *  Four is a conservative fraction of the ~20 concurrent turns measured to collapse a single event loop
 *  (p99 4366 ms), and it sits deliberately BELOW {@link MAX_TURNS_PER_RUNNER} so the pool reaches for a
 *  new runner before it starts making turns queue. */
export const SATURATING_TURNS = 4;

/** Admission limit per runner. This is PLACEMENT, not a concurrency cap: a turn that does not fit QUEUES
 *  and runs later — it is never refused, because time-sharing is the intended behaviour. Eight holds one
 *  runner at roughly 40% of the measured breaking point while still letting turns share the loop. */
export const MAX_TURNS_PER_RUNNER = 8;

/** Minimum gap between spawns. A workflow `tick()` launches EVERY ready node in one event-loop turn, so
 *  without a cooldown a 20-node DAG would ask for twenty runners before the first had finished booting.
 *  15 s is comfortably longer than an observed cold runner boot (plugin load dominates it), so each new
 *  runner has actually joined the pool and absorbed load before the next one is even considered. */
export const GROWTH_COOLDOWN_MS = 15_000;

/** How long a runner must have served NOTHING before it is reaped. Long enough to keep a warm runner
 *  across the gap between two waves of one workflow — re-forking costs a cold plugin boot, which is the
 *  expensive thing here — and short enough that an idle night hands ~0.5 GB per runner back to the OS. */
export const IDLE_REAP_MS = 120_000;

/** How often a runner reports its own state upward. Fast enough that {@link SATURATED_BEATS} beats are a
 *  few seconds of evidence rather than a minute, slow enough that the IPC traffic is irrelevant next to a
 *  turn's own message volume. */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/** The runner's lag sampling window, as a multiple of the heartbeat interval. Five keeps each reading
 *  describing the recent past — with the double-buffered window a stall stays reported for 5–10 s after
 *  it ends, and every beat reads at least half a window of real history (see {@link SATURATED_BEATS}). */
export const LAG_WINDOW_MS = HEARTBEAT_INTERVAL_MS * 5;

/** Linux reports MemFree in `os.freemem()`, which is NOT the memory a new process can have: page cache is
 *  reclaimable and counts as used. On this very machine the two differ by 3x (7.3 GB free vs 20.9 GB
 *  available), so sizing off `freemem()` would refuse to spawn on a perfectly healthy box. Read
 *  MemAvailable when the kernel offers it and fall back to `freemem()` only where it does not exist. */
function linuxMemAvailableBytes(): number | undefined {
  try {
    const line = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (!line?.[1]) return undefined;
    const kb = Number(line[1]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

/** The real machine. Every reading is taken FRESH on each call — a cap computed once at boot would keep
 *  spawning against memory that has since been handed to something else. */
export function realMachine(): MachineInputs {
  return {
    cpus: () => availableParallelism(),
    totalMemBytes: () => totalmem(),
    availableMemBytes: () => linuxMemAvailableBytes() ?? freemem(),
  };
}

/** The operator's knob, resolved. The ENVIRONMENT WINS over the stored setting, because the situation the
 *  knob exists for — a container whose CPU quota and memory limit the machine's own APIs report straight
 *  past — is one an operator has to fix at deploy time, on a daemon that may not even be reachable to take
 *  a config write. A blank or unparseable value is not an override; it falls through to the setting rather
 *  than silently disabling the pool. */
export function resolvePoolMax(setting: number | null | undefined, env: string | undefined): number | null {
  const raw = env?.trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return setting ?? null;
}

export interface PoolSizing {
  /** The effective cap: the LOWER of what the CPUs and the memory allow, then the operator's knob. */
  cap: number;
  cpuCap: number;
  memCap: number;
  /** The runner RSS the memory ceiling was derived from — the estimate, or what runners actually report. */
  runnerRssBytes: number;
  /** True when the operator's knob, rather than the machine, decided the cap. */
  operatorCapped: boolean;
}

export interface SizingOpts {
  /** Measured resident size of a live runner. Absent until one has reported a heartbeat. */
  measuredRunnerRssBytes?: number;
  /** The operator's knob. `null`/absent = auto (size from the machine); 0 = pool disabled; N = hard cap. */
  operatorMax?: number | null;
}

/** THE sizing rule.
 *
 *  CPU ceiling: one core's worth is left to the daemon, because a runner that took the last core would
 *  starve the very event loop this whole mechanism exists to protect. Floor of 1 — a single-core box still
 *  gets one runner, since moving the work OFF the daemon's loop is worth more there than anywhere else.
 *
 *  Memory ceiling: how many runners fit in {@link MEM_BUDGET_FRACTION} of total memory at the measured
 *  runner size. Not floored at 1: a box that genuinely cannot hold one runner must spawn zero and stay
 *  in-process, rather than fork itself into the OOM killer.
 *
 *  The operator's knob only ever NARROWS. It cannot raise the cap above what the machine says, because a
 *  knob that could would just be a slower way to OOM. */
export function poolSizing(inputs: MachineInputs, opts: SizingOpts = {}): PoolSizing {
  const runnerRssBytes = opts.measuredRunnerRssBytes && opts.measuredRunnerRssBytes > 0
    ? opts.measuredRunnerRssBytes
    : ESTIMATED_RUNNER_RSS_BYTES;
  const cpuCap = Math.max(1, Math.floor(inputs.cpus()) - 1);
  const memCap = Math.max(0, Math.floor((inputs.totalMemBytes() * MEM_BUDGET_FRACTION) / runnerRssBytes));
  const machineCap = Math.min(cpuCap, memCap);
  const knob = opts.operatorMax;
  const operatorCapped = typeof knob === 'number' && Number.isFinite(knob) && knob >= 0 && knob < machineCap;
  return {
    cap: operatorCapped ? Math.floor(knob as number) : machineCap,
    cpuCap,
    memCap,
    runnerRssBytes,
    operatorCapped,
  };
}

/** Could this machine give a NEW runner its memory right now? Checked at the moment of spawning rather
 *  than folded into the cap, because the cap answers "how many could ever fit" while this answers "is
 *  there room this second" — and the second question is the one that decides between forking and packing
 *  the turn onto a runner that already exists. */
export function canAffordSpawn(inputs: MachineInputs, runnerRssBytes: number): boolean {
  return inputs.availableMemBytes() >= runnerRssBytes * SPAWN_HEADROOM;
}

/** What the pool knows about one runner when it decides. */
export interface RunnerLoad {
  /** Turns the pool has PLACED and not yet seen settle. Exact and synchronous — see SubagentRunnerPool. */
  activeTurns: number;
  /** Consecutive heartbeats this runner has reported a p99 over {@link SATURATION_P99_MS}. */
  saturatedBeats: number;
}

/** Is this runner at its comfort line?
 *
 *  Note the `activeTurns >= 1` guard on the lag arm: a runner with NO work is never saturated, whatever
 *  its loop says. That is not merely sensible — it is what makes "saturated" and "reapable" provably
 *  disjoint predicates, which is the whole anti-flapping argument (see SubagentRunnerPool). */
export function isSaturated(load: RunnerLoad): boolean {
  if (load.activeTurns >= SATURATING_TURNS) return true;
  return load.activeTurns >= 1 && load.saturatedBeats >= SATURATED_BEATS;
}

export interface ReapInputs {
  /** Turns placed here and not yet settled — the pool's exact count. */
  activeTurns: number;
  /** Sessions still routed to this runner. A route is a PROMISE that the channel lives in this process. */
  routedSessions: number;
  /** Time since this runner last started or finished a turn. */
  idleMs: number;
}

/** May this runner be shut down?
 *
 *  Deliberately the exact complement of the `activeTurns >= 1` requirement inside {@link isSaturated}:
 *  no runner can be saturated and reapable at the same instant, which is the load-bearing half of the
 *  anti-flapping argument in pool.ts. */
export function isReapable(r: ReapInputs): boolean {
  return r.activeTurns === 0 && r.routedSessions === 0 && r.idleMs >= IDLE_REAP_MS;
}

export interface GrowthInputs {
  /** Every live runner's load. Empty means there is nothing to be saturated, so growth is a COLD START —
   *  handled separately by the pool, which must be able to report "unavailable" and fall back in-process. */
  runners: RunnerLoad[];
  /** A turn is queued, or one had to be placed onto an already-saturated runner. */
  pressure: boolean;
  cap: number;
  /** Milliseconds since the last spawn (Infinity when none yet). */
  sinceLastSpawnMs: number;
  /** Whether current free memory could cover another runner — see {@link canAffordSpawn}. */
  memoryAllows: boolean;
}

/** Grow only on SUSTAINED evidence that every runner is busy and something is still waiting. Each clause
 *  removes a distinct way to spawn a herd: `pressure` stops growth with nothing to gain, "every runner
 *  saturated" stops it while capacity already exists, `cap` stops it past what the machine can hold,
 *  the cooldown stops one burst becoming N spawns, and `memoryAllows` stops it when the box would swap. */
export function shouldGrow(g: GrowthInputs): boolean {
  if (!g.pressure) return false;
  if (g.runners.length === 0) return false;
  if (g.runners.length >= g.cap) return false;
  if (g.sinceLastSpawnMs < GROWTH_COOLDOWN_MS) return false;
  if (!g.memoryAllows) return false;
  return g.runners.every(isSaturated);
}
