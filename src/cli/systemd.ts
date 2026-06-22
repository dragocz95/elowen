import { execFile } from 'node:child_process';

/** The two units `orca install` provisions. Shared so the menu and the updater drive the same names. */
export const SERVICES = ['orca-daemon', 'orca-web'];

/** Run a command, resolving its exit code + stdout (never rejects). */
export function runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? '' });
    });
  });
}

/** systemctl, transparently via sudo when we aren't root (so a non-root operator — e.g. the services'
 *  own www-data with passwordless sudo — still manages the units). */
export function systemctl(...args: string[]): Promise<{ code: number; stdout: string }> {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return asRoot ? runCmd('systemctl', args) : runCmd('sudo', ['systemctl', ...args]);
}

/** Whether all ORCA units report active. */
export async function servicesActive(): Promise<boolean> {
  const r = await systemctl('is-active', ...SERVICES);
  const states = r.stdout.trim().split('\n');
  return states.length > 0 && states.every((s) => s.trim() === 'active');
}
