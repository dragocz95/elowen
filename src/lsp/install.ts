import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The npm prefix Orca installs language servers into: `<data dir>/lsp`, owned by whichever user runs
 *  Orca. Installing into the SYSTEM global prefix (`npm -g`) needs root and fails under systemd
 *  (the daemon runs as a service user whose npm prefix is /usr) — so Orca keeps its own prefix and
 *  resolves server binaries from `<prefix>/bin` first (see resolveServerCommand). */
export function lspPrefixDir(): string {
  const base = process.env.ORCA_DB ? dirname(process.env.ORCA_DB) : join(homedir(), '.config', 'orca');
  return join(base, 'lsp');
}

/** Run `npm install -g --prefix <lsp dir> <packages>` — the ONE npm-install runner behind every LSP
 *  install surface (setup wizard, /lsp modal ctrl+i via POST /brain/lsp/install). Array-argv spawn
 *  (never a shell string, so nothing gets re-parsed); npm on Windows is a `.cmd` shim, which does need
 *  the shell. Resolves — never rejects — with ok + a short failure detail (last stderr lines). */
export function npmInstallGlobal(packages: string[], prefix = lspPrefixDir()): Promise<{ ok: boolean; detail: string }> {
  try { mkdirSync(prefix, { recursive: true }); }
  catch (e) { return Promise.resolve({ ok: false, detail: (e as Error).message }); }
  return runNpm(['install', '-g', '--prefix', prefix, ...packages], 'installed');
}

/** Remove packages from Orca's LSP prefix (the /lsp modal's ctrl+u). Only touches Orca's own prefix —
 *  a system-installed copy of the same server is never uninstalled from here. */
export function npmUninstallGlobal(packages: string[], prefix = lspPrefixDir()): Promise<{ ok: boolean; detail: string }> {
  return runNpm(['uninstall', '-g', '--prefix', prefix, ...packages], 'uninstalled');
}

function runNpm(args: string[], okDetail: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', args, { stdio: ['ignore', 'ignore', 'pipe'], shell: win });
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('exit', (code) => {
      if (code === 0) { resolve({ ok: true, detail: okDetail }); return; }
      resolve({ ok: false, detail: stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `npm exited with code ${code}` });
    });
  });
}
