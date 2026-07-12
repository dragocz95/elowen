import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface ProcessIdentity { pid: number; startTime: string }
export interface LinuxProcessOwner { name: string; value: string }

interface ProcessCommandResult {
  status: number | null;
  error?: Error;
  stdout?: string | null;
}

interface ProcessCommandOptions {
  encoding: 'utf8';
  shell: false;
  timeout: number;
  windowsHide: true;
  stdio: 'ignore' | ['ignore', 'pipe', 'ignore'];
}

type ProcessCommandRunner = (
  command: string,
  args: string[],
  options: ProcessCommandOptions,
) => ProcessCommandResult;

const runProcessCommand: ProcessCommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, options);
  return {
    status: result.status,
    error: result.error,
    stdout: typeof result.stdout === 'string' ? result.stdout : null,
  };
};

const WINDOWS_TREE_KILL_TIMEOUT_MS = 250;
const POSIX_SNAPSHOT_TIMEOUT_MS = 100;

export interface ProcessPlatformDeps {
  platform?: NodeJS.Platform;
  run?: ProcessCommandRunner;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

/** Platform-native whole-tree signal. Windows uses taskkill with an argv array and an explicit timeout;
 * no command is ever interpolated into a shell. POSIX callers spawn a detached group whose numeric leader
 * is safe to signal immediately. Delayed POSIX escalation is birth-validated by the owner below. */
export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals = 'SIGTERM',
  deps: ProcessPlatformDeps = {},
): boolean {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' && child.pid) {
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    try {
      const result = (deps.run ?? runProcessCommand)('taskkill.exe', args, {
        encoding: 'utf8',
        shell: false,
        timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
        windowsHide: true,
        stdio: 'ignore',
      });
      if (!result.error && result.status === 0) return true;
    } catch {
      // The direct child handle remains a bounded last fallback when taskkill itself is unavailable.
    }
    try { return child.kill(signal); } catch { return false; }
  }
  if (platform !== 'win32' && child.pid) {
    try {
      (deps.signalProcess ?? process.kill)(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

function linuxProcess(pid: number): { identity: ProcessIdentity; pgid: number } | null {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commEnd = stat.lastIndexOf(')');
    if (commEnd < 0) return null;
    // Fields after comm start at field 3 (state): pgrp is index 2, starttime is index 19.
    const fields = stat.slice(commEnd + 2).trim().split(/\s+/);
    if (!fields[19]) return null;
    return { identity: { pid, startTime: fields[19] }, pgid: Number(fields[2]) };
  } catch {
    return null;
  }
}

/** Capture one Linux PID at its current birth identity without scanning the whole process table. */
function snapshotLinuxProcess(pid: number): { identity: ProcessIdentity; pgid: number } | null {
  return linuxProcess(pid);
}

/** Identities currently belonging to a Linux process group. `null` means the platform/procfs cannot
 * provide PID-birth validation and the caller must use its native fallback. */
function snapshotLinuxProcessGroup(pgid: number): ProcessIdentity[] | null {
  if (process.platform !== 'linux') return null;
  let names: string[];
  try { names = readdirSync('/proc'); } catch { return null; }
  const members: ProcessIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const row = linuxProcess(Number(name));
    if (row?.pgid === pgid) members.push(row.identity);
  }
  return members;
}

function isSameLinuxProcess(identity: ProcessIdentity, pgid?: number): boolean {
  const row = linuxProcess(identity.pid);
  return row?.identity.startTime === identity.startTime && (pgid === undefined || row.pgid === pgid);
}

/** Verify that one birth-identity-matched Linux process still carries an application-owned environment
 * marker. Descendants inherit this marker, letting a TERM-grace resnapshot distinguish a late fork from
 * an unrelated process group that happens to reuse the numeric pgid. */
function isOwnedLinuxProcess(identity: ProcessIdentity, owner: LinuxProcessOwner): boolean {
  const before = linuxProcess(identity.pid);
  if (before?.identity.startTime !== identity.startTime) return false;
  try {
    const environment = readFileSync(`/proc/${identity.pid}/environ`);
    const entry = Buffer.from(`${owner.name}=${owner.value}`);
    let offset = 0;
    let found = false;
    while (offset <= environment.length) {
      const end = environment.indexOf(0, offset);
      const boundary = end < 0 ? environment.length : end;
      if (environment.subarray(offset, boundary).equals(entry)) { found = true; break; }
      if (end < 0) break;
      offset = end + 1;
    }
    // Reading /proc and acting are separate syscalls. Re-check the birth identity so a PID recycled
    // during the read is never accepted as one of our descendants.
    return found && isSameLinuxProcess(identity);
  } catch {
    return false;
  }
}

function posixProcesses(deps: ProcessPlatformDeps = {}): Array<{ identity: ProcessIdentity; pgid: number }> | null {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return null;
  try {
    const result = (deps.run ?? runProcessCommand)('ps', ['-axo', 'pid=,pgid=,lstart='], {
      encoding: 'utf8',
      shell: false,
      timeout: POSIX_SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
    const rows: Array<{ identity: ProcessIdentity; pgid: number }> = [];
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const pgid = Number(match[2]);
      const startTime = match[3]!;
      if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(pgid) && pgid > 0) {
        rows.push({ identity: { pid, startTime }, pgid });
      }
    }
    return rows;
  } catch {
    return null;
  }
}

/** Portable best-effort PID birth snapshot for non-Linux POSIX. `ps lstart` is only second-precise on
 * Darwin/BSD, so it is used to make delayed escalation materially safer, never to authorize a numeric
 * group kill. Signals are sent only to positive PIDs whose captured identities still match. */
function snapshotPosixProcess(
  pid: number,
  deps: ProcessPlatformDeps = {},
): { identity: ProcessIdentity; pgid: number } | null {
  return posixProcesses(deps)?.find((row) => row.identity.pid === pid) ?? null;
}

export function snapshotPosixProcessGroup(
  pgid: number,
  deps: ProcessPlatformDeps = {},
): ProcessIdentity[] | null {
  const rows = posixProcesses(deps);
  return rows?.filter((row) => row.pgid === pgid).map((row) => row.identity) ?? null;
}

function isSamePosixProcess(
  identity: ProcessIdentity,
  pgid?: number,
  deps: ProcessPlatformDeps = {},
): boolean {
  const row = snapshotPosixProcess(identity.pid, deps);
  return row?.identity.startTime === identity.startTime && (pgid === undefined || row.pgid === pgid);
}

const PROCESS_GROUP_POLL_MS = 5;
/** Verification is deliberately below the 350ms application-task bound. An unkillable/D-state process
 * cannot keep the chat alive forever; after this final birth-safe kill pass the child pipes are detached. */
export const PROCESS_GROUP_VERIFY_MS = 75;

type TerminationReason = 'abort' | 'timeout' | 'overflow';
type ScheduledTimer = ReturnType<typeof setTimeout>;

export interface ProcessGroupTerminationDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  snapshotProcess?: (pid: number) => { identity: ProcessIdentity; pgid: number } | null;
  snapshotGroup?: (pgid: number) => ProcessIdentity[] | null;
  isSameProcess?: (identity: ProcessIdentity, pgid?: number) => boolean;
  isOwnedProcess?: (identity: ProcessIdentity, owner: LinuxProcessOwner) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  terminateTree?: (child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals) => boolean;
  schedule?: (callback: () => void, delayMs: number) => ScheduledTimer;
  cancelScheduled?: (timer: ScheduledTimer) => void;
}

/** Sole owner of one spawned shell group. Timeout, output overflow and application abort converge on a
 * single bounded TERM→KILL transaction. Linux uses procfs birth identities plus the inherited owner
 * marker. Other POSIX systems use `ps` birth snapshots and positive-PID signals; if continuity cannot be
 * proved they deliberately decline a delayed negative-PGID kill rather than risk a recycled group. */
export class BoundedProcessGroupTermination {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly snapshotProcessImpl: (pid: number) => { identity: ProcessIdentity; pgid: number } | null;
  private readonly snapshotGroupImpl: (pgid: number) => ProcessIdentity[] | null;
  private readonly isSameProcessImpl: (identity: ProcessIdentity, pgid?: number) => boolean;
  private readonly isOwnedProcessImpl: (identity: ProcessIdentity, owner: LinuxProcessOwner) => boolean;
  private readonly signalProcessImpl: (pid: number, signal: NodeJS.Signals) => void;
  private readonly terminateTreeImpl: (child: Pick<ChildProcess, 'pid' | 'kill'>, signal: NodeJS.Signals) => boolean;
  private readonly scheduleImpl: (callback: () => void, delayMs: number) => ScheduledTimer;
  private readonly cancelScheduledImpl: (timer: ScheduledTimer) => void;
  private readonly pgid: number | undefined;
  private readonly identities = new Map<number, ProcessIdentity>();
  private portableSnapshot = new Map<number, ProcessIdentity>();
  private readonly termSignalled = new Set<string>();
  private tracking: boolean;
  private requested = false;
  private firstReason: TerminationReason | null = null;
  private forced = false;
  private forceDeadline = 0;
  private forceTimer: ScheduledTimer | null = null;
  private pollTimer: ScheduledTimer | null = null;
  private settlement: Promise<void> | null = null;
  private settle: (() => void) | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly graceMs: number,
    private readonly owner: LinuxProcessOwner,
    deps: ProcessGroupTerminationDeps = {},
  ) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    const nativeDeps: ProcessPlatformDeps = { platform: this.platform };
    this.snapshotProcessImpl = deps.snapshotProcess ?? (this.platform === 'linux'
      ? snapshotLinuxProcess
      : (pid) => snapshotPosixProcess(pid, nativeDeps));
    this.snapshotGroupImpl = deps.snapshotGroup ?? (this.platform === 'linux'
      ? snapshotLinuxProcessGroup
      : (pgid) => snapshotPosixProcessGroup(pgid, nativeDeps));
    this.isSameProcessImpl = deps.isSameProcess ?? (this.platform === 'linux'
      ? isSameLinuxProcess
      : (identity, pgid) => isSamePosixProcess(identity, pgid, nativeDeps));
    this.isOwnedProcessImpl = deps.isOwnedProcess ?? (this.platform === 'linux'
      ? isOwnedLinuxProcess
      : () => false);
    this.signalProcessImpl = deps.signalProcess ?? ((pid, signal) => { process.kill(pid, signal); });
    this.terminateTreeImpl = deps.terminateTree ?? ((child, signal) => terminateProcessTree(child, signal, nativeDeps));
    this.scheduleImpl = deps.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduledImpl = deps.cancelScheduled ?? clearTimeout;
    this.pgid = child.pid;
    const leader = this.pgid ? this.snapshotProcessImpl(this.pgid) : null;
    this.tracking = this.platform === 'linux' || (this.platform !== 'win32' && leader !== null);
    if (leader && leader.pgid === this.pgid) this.identities.set(leader.identity.pid, leader.identity);
  }

  terminate(reason: TerminationReason): Promise<void> {
    if (this.requested) {
      // A timeout/output-overflow already spent part of its grace. Application teardown may not spend it
      // again: the full resnapshot + KILL boundary runs synchronously in the abort call stack.
      if (reason === 'abort' && this.firstReason !== 'abort') this.force();
      return this.settlement!;
    }
    this.requested = true;
    this.firstReason = reason;
    this.settlement = new Promise<void>((resolve) => { this.settle = resolve; });

    if (this.tracking) {
      this.captureGroup();
      if (!this.settle) return this.settlement;
      const live = this.liveIdentities();
      if (reason !== 'abort' && live.length > 0) this.signalIdentities(live, 'SIGTERM');
      else if (reason !== 'abort') this.terminateTreeImpl(this.child, 'SIGTERM');
    } else if (reason !== 'abort') {
      this.terminateTreeImpl(this.child, 'SIGTERM');
    }

    if (reason === 'abort') this.force();
    else if (this.settle) this.forceTimer = this.arm(() => this.force(), Math.max(0, this.graceMs));
    return this.settlement;
  }

  waitForSettlement(): Promise<void> | null { return this.settlement; }

  /** Stop all pending work and settle the fence synchronously. Used only after the caller has detached
   * its child handles; normal termination reaches the same cleanup through its bounded deadline. */
  cancel(): void { this.finishSettlement(); }

  private force(): void {
    if (!this.settle || this.forced) return;
    this.forced = true;
    this.clearForceTimer();
    this.forceDeadline = this.now() + PROCESS_GROUP_VERIFY_MS;

    if (this.tracking) {
      this.captureGroup();
      if (!this.settle) return;
      const live = this.liveIdentities();
      if (live.length > 0) this.signalIdentities(live, 'SIGKILL');
      else if (this.platform === 'linux') {
        // Direct-handle fallback only; never use a delayed numeric group when procfs could not prove it.
        try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
      } else if (this.firstReason === 'abort' && this.childRunning()) {
        // Immediate fatal teardown still owns the leader, so a native group kill is safe at this boundary.
        this.terminateTreeImpl(this.child, 'SIGKILL');
      }
      this.verifyForcedGroup();
      return;
    }

    this.forceNativeFallback();
    this.finishSettlement();
  }

  private forceNativeFallback(): void {
    if (this.platform === 'win32' || this.firstReason === 'abort' || this.childRunning()) {
      this.terminateTreeImpl(this.child, 'SIGKILL');
      return;
    }
    // On a non-Linux POSIX fallback, an exited leader means the PGID can theoretically be recycled. The
    // ChildProcess handle cannot target a replacement PID, so it is the only safe delayed fallback.
    try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  private captureGroup(): void {
    if (!this.settle || !this.pgid || !this.tracking) return;
    const snapshot = this.snapshotGroupImpl(this.pgid);
    if (snapshot === null) {
      this.portableSnapshot.clear();
      this.tracking = false;
      if (this.forced) {
        this.forceNativeFallback();
        this.finishSettlement();
      }
      return;
    }
    if (this.platform !== 'linux') {
      this.portableSnapshot = new Map(snapshot.map((identity) => [identity.pid, identity]));
    }
    const continuous = snapshot.some((identity) => {
      const known = this.identities.get(identity.pid);
      return known?.startTime === identity.startTime && this.isCurrent(identity);
    });
    for (const identity of snapshot) {
      const known = this.identities.get(identity.pid);
      if (continuous
        || known?.startTime === identity.startTime
        || (this.platform === 'linux' && this.isOwnedProcessImpl(identity, this.owner))) {
        this.identities.set(identity.pid, identity);
      }
    }
  }

  private liveIdentities(): ProcessIdentity[] {
    if (!this.pgid) return [];
    const live: ProcessIdentity[] = [];
    for (const [pid, identity] of this.identities) {
      if (this.isCurrent(identity)) live.push(identity);
      else this.identities.delete(pid);
    }
    return live;
  }

  private signalIdentities(identities: readonly ProcessIdentity[], signal: 'SIGTERM' | 'SIGKILL'): void {
    if (!this.pgid) return;
    for (const identity of identities) {
      const key = `${identity.pid}:${identity.startTime}`;
      if (signal === 'SIGTERM' && this.termSignalled.has(key)) continue;
      if (!this.isCurrent(identity)) continue;
      try { this.signalProcessImpl(identity.pid, signal); } catch { /* already gone */ }
      if (signal === 'SIGTERM') this.termSignalled.add(key);
    }
  }

  private verifyForcedGroup(): void {
    if (!this.settle || this.pollTimer) return;
    const remaining = this.forceDeadline - this.now();
    if (remaining <= 0) {
      this.finalKillPass();
      return;
    }
    this.pollTimer = this.arm(() => {
      this.pollTimer = null;
      if (!this.settle) return;
      if (this.now() >= this.forceDeadline) {
        this.finalKillPass();
        return;
      }
      this.captureGroup();
      if (!this.settle) return;
      const live = this.liveIdentities();
      if (live.length > 0) {
        this.signalIdentities(live, 'SIGKILL');
        this.verifyForcedGroup();
      } else {
        // One delayed resnapshot is enough to close the force-boundary fork race. If it is empty, there
        // is no reason to retain even an unref'ed verification timer until the hard deadline.
        this.finishSettlement();
      }
    }, Math.min(PROCESS_GROUP_POLL_MS, remaining));
  }

  private finalKillPass(): void {
    if (!this.settle) return;
    this.captureGroup();
    if (!this.settle) return;
    const live = this.liveIdentities();
    if (live.length > 0) this.signalIdentities(live, 'SIGKILL');
    this.finishSettlement();
  }

  private childRunning(): boolean {
    return (this.child.exitCode === null || this.child.exitCode === undefined)
      && (this.child.signalCode === null || this.child.signalCode === undefined);
  }

  private isCurrent(identity: ProcessIdentity): boolean {
    if (this.platform === 'linux') return this.isSameProcessImpl(identity, this.pgid);
    return this.portableSnapshot.get(identity.pid)?.startTime === identity.startTime;
  }

  private arm(callback: () => void, delayMs: number): ScheduledTimer {
    const timer = this.scheduleImpl(callback, delayMs);
    timer.unref?.();
    return timer;
  }

  private clearForceTimer(): void {
    if (this.forceTimer) this.cancelScheduledImpl(this.forceTimer);
    this.forceTimer = null;
  }

  private finishSettlement(): void {
    const settle = this.settle;
    this.settle = null;
    this.clearForceTimer();
    if (this.pollTimer) this.cancelScheduledImpl(this.pollTimer);
    this.pollTimer = null;
    settle?.();
  }
}

/** TERM→KILL owner for one direct child (the inherited-TTY external editor). A normal `close` cancels
 * escalation; otherwise the Linux birth identity prevents a delayed timer from killing a recycled PID. */
export class BoundedChildTermination {
  private requested = false;
  private forceTimer: ReturnType<typeof setTimeout> | null = null;
  private identity: ProcessIdentity | null = null;

  constructor(private readonly child: ChildProcess, private readonly graceMs: number) {}

  terminate(): boolean {
    if (this.requested) return true;
    this.requested = true;
    if (this.child.pid) this.identity = linuxProcess(this.child.pid)?.identity ?? null;
    let sent = false;
    try { sent = this.child.kill('SIGTERM'); } catch { return false; }
    if (!sent) return false;
    this.forceTimer = setTimeout(() => {
      this.forceTimer = null;
      if (this.identity && !isSameLinuxProcess(this.identity)) return;
      // On non-Linux/no-procfs, ChildProcess.exitCode is the strongest available reuse guard.
      if (!this.identity && this.child.exitCode !== null && this.child.exitCode !== undefined) return;
      try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
    }, Math.max(0, this.graceMs));
    return true;
  }

  complete(): void {
    if (this.forceTimer) clearTimeout(this.forceTimer);
    this.forceTimer = null;
  }
}
