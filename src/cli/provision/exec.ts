import * as p from '../ui/prompts.js';
import type { Runner } from '../install/runner.js';

/** Shared system-provisioning primitives used by both `elowen install` and `elowen setup`'s optional
 *  deployment step, so the two flows drive the exact same executors (single source of truth). */

/** Run a command and throw with its stderr when it fails — used for the system mutations where a
 *  non-zero exit must abort rather than silently continue. */
export async function must(r: Runner, cmd: string, args: string[], opts?: { user?: string }): Promise<void> {
  const res = await r.exec(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(res.stderr || res.stdout).trim() || res.code}`);
}

export async function aptInstall(r: Runner, ...pkgs: string[]): Promise<void> {
  await must(r, 'apt-get', ['update']);
  await must(r, 'apt-get', ['install', '-y', ...pkgs]);
}

/** Run a labelled provisioning step. Off a TTY (unattended / CI / piped logs) a spinner just spams frames,
 *  so emit one line per step; on a TTY, show a spinner that resolves to ok/failed. */
export async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    try { const out = await fn(); p.log.success(label); return out; }
    catch (e) { p.log.error(`${label} — failed`); throw e; }
  }
  const s = p.spinner();
  s.start(label);
  try { const out = await fn(); s.stop(`${label} ok`); return out; }
  catch (e) { s.stop(`${label} failed`, 'error'); throw e; }
}
