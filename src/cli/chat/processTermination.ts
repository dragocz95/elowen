import { readFileSync, readdirSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

export interface ProcessIdentity { pid: number; startTime: string }

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

/** Identities currently belonging to a Linux process group. `null` means the platform/procfs cannot
 * provide PID-birth validation and the caller must use its native fallback. */
export function snapshotLinuxProcessGroup(pgid: number): ProcessIdentity[] | null {
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

export function isSameLinuxProcess(identity: ProcessIdentity, pgid?: number): boolean {
  const row = linuxProcess(identity.pid);
  return row?.identity.startTime === identity.startTime && (pgid === undefined || row.pgid === pgid);
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
