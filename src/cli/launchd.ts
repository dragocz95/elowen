import { homedir } from 'node:os';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCmd } from './systemd.js';
import { LAUNCHD_SERVICES, agentPlistPath } from './install/launchdUnits.js';

/** launchd counterparts of the systemd helpers — the macOS `elowen install` provisions per-user
 *  LaunchAgents in the `gui/<uid>` domain, and the launcher menu + updater drive them through these.
 *  Everything runs as the invoking user; there is no sudo anywhere on this path. */

type Run = typeof runCmd;

function guiTarget(label?: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  return label ? `gui/${uid}/${label}` : `gui/${uid}`;
}

/** (Re)load + start both agents from their plists. `bootout` first so a re-run replaces a stale
 *  bootstrap instead of failing with "already bootstrapped"; its failure (not loaded yet) is expected. */
export async function launchdStart(run: Run = runCmd, home = homedir()): Promise<{ code: number; stdout: string }> {
  for (const label of LAUNCHD_SERVICES) {
    await run('launchctl', ['bootout', guiTarget(label)]);
    const r = await run('launchctl', ['bootstrap', guiTarget(), agentPlistPath(home, label)]);
    if (r.code !== 0) return r;
  }
  return { code: 0, stdout: '' };
}

/** Unload both agents (KeepAlive would resurrect a plain kill, so stopping means booting them out). */
export async function launchdStop(run: Run = runCmd): Promise<{ code: number; stdout: string }> {
  let worst = { code: 0, stdout: '' };
  for (const label of LAUNCHD_SERVICES) {
    const r = await run('launchctl', ['bootout', guiTarget(label)]);
    if (r.code !== 0) worst = r;
  }
  return worst;
}

/** Restart both agents in place: kickstart -k kills + relaunches a LOADED agent; an unloaded one is
 *  bootstrapped instead, so restart doubles as start (mirrors `systemctl restart` semantics). */
export async function launchdRestart(run: Run = runCmd, home = homedir()): Promise<{ code: number; stdout: string }> {
  for (const label of LAUNCHD_SERVICES) {
    const r = await run('launchctl', ['kickstart', '-k', guiTarget(label)]);
    if (r.code !== 0) {
      const boot = await run('launchctl', ['bootstrap', guiTarget(), agentPlistPath(home, label)]);
      if (boot.code !== 0) return r;
    }
  }
  return { code: 0, stdout: '' };
}

/** Whether both agents are loaded and running (launchd print reports `state = running`). */
export async function launchdServicesActive(run: Run = runCmd): Promise<boolean> {
  for (const label of LAUNCHD_SERVICES) {
    const r = await run('launchctl', ['print', guiTarget(label)]);
    if (r.code !== 0 || !/state = running/.test(r.stdout)) return false;
  }
  return true;
}

/** Human status text: the `state =` / `pid =` lines of each agent, the closest launchd analogue of a
 *  terse `systemctl status`. */
export async function launchdStatusText(run: Run = runCmd): Promise<string> {
  const out: string[] = [];
  for (const label of LAUNCHD_SERVICES) {
    const r = await run('launchctl', ['print', guiTarget(label)]);
    if (r.code !== 0) { out.push(`${label}: not loaded`); continue; }
    const lines = r.stdout.split('\n').filter((l) => /\b(state|pid) = /.test(l)).map((l) => l.trim());
    out.push(`${label}: ${lines.join(' · ') || 'loaded'}`);
  }
  return out.join('\n');
}

/** Tail of the newest launchd log under ~/.config/elowen/logs — journalctl's stand-in on macOS. */
export function launchdLogTail(home = homedir(), lines = 20): string {
  try {
    const dir = join(home, '.config', 'elowen', 'logs');
    const logs = readdirSync(dir).filter((f) => f.startsWith('launchd-daemon'));
    if (!logs.length) return '';
    const body = readFileSync(join(dir, logs[logs.length - 1]!), 'utf8');
    return body.split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '';
  }
}
