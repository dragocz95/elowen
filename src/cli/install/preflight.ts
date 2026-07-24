import type { Runner } from './runner.js';

/** Environment checks `elowen install` runs before touching anything. Pure result + a human blocker
 *  list, so the wizard can refuse early with exact remediation. */
export interface PreflightResult {
  /** Where we're provisioning: root+apt+systemd on Linux, current-user+brew+launchd on macOS. */
  platform: 'linux' | 'darwin';
  isRoot: boolean;
  pkgManager: 'apt' | 'brew' | null;
  node: { ok: boolean; version: string };
  tmux: boolean;
  /** C toolchain + python3 present — node-pty's native addon builds from source without them only via
   *  a prebuilt binary. NOT a blocker: absent → the installer apt-installs them, and if that fails the
   *  terminal stream simply degrades to the snapshot mirror. */
  buildTools: boolean;
}

const MIN_NODE_MAJOR = 22;

export async function preflight(r: Runner, platform = process.platform): Promise<PreflightResult> {
  const id = await r.exec('id', ['-u']);
  const node = await r.exec('node', ['-v']);
  const version = node.stdout.trim();
  const major = Number(version.replace(/^v/, '').split('.')[0]) || 0;
  const darwin = platform === 'darwin';
  return {
    platform: darwin ? 'darwin' : 'linux',
    isRoot: id.stdout.trim() === '0',
    pkgManager: darwin
      ? ((await r.which('brew')) ? 'brew' : null)
      : ((await r.which('apt-get')) ? 'apt' : null),
    node: { ok: major >= MIN_NODE_MAJOR, version },
    tmux: (await r.which('tmux')) !== null,
    buildTools: (await r.which('cc')) !== null && (await r.which('python3')) !== null,
  };
}

/** Hard blockers (must be empty to proceed). tmux is NOT a blocker — the wizard offers to install it
 *  (apt on Linux, brew on macOS) — so it only bites on macOS when there is no brew to install it WITH. */
export function preflightBlockers(p: PreflightResult): string[] {
  const out: string[] = [];
  if (p.platform === 'darwin') {
    // Everything on macOS is per-user: Homebrew refuses root and the LaunchAgents live in the invoker's
    // gui domain, so running under sudo would provision the wrong (root) user.
    if (p.isRoot) out.push('Do not run as root on macOS — elowen provisions per-user launchd agents. Re-run without sudo.');
    if (!p.pkgManager && !p.tmux) out.push('Homebrew is required to install tmux — install it from https://brew.sh (or install tmux yourself) and re-run.');
  } else {
    if (!p.isRoot) out.push('Must run as root — try: sudo elowen install');
    if (!p.pkgManager) out.push('Unsupported OS: elowen install needs apt (Debian/Ubuntu) or macOS in this version');
  }
  if (!p.node.ok) out.push(`Node ${MIN_NODE_MAJOR}+ required (found ${p.node.version || 'none'})`);
  return out;
}
