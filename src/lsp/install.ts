import { spawn } from 'node:child_process';

/** Run `npm install -g <packages>` — the ONE npm-install runner behind every LSP install surface
 *  (setup wizard, /lsp modal ctrl+i via POST /brain/lsp/install). Array-argv spawn (never a shell
 *  string, so nothing gets re-parsed); npm on Windows is a `.cmd` shim, which does need the shell.
 *  Resolves — never rejects — with ok + a short failure detail (last stderr lines). */
export function npmInstallGlobal(packages: string[]): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', ['install', '-g', ...packages], { stdio: ['ignore', 'ignore', 'pipe'], shell: win });
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('exit', (code) => {
      if (code === 0) { resolve({ ok: true, detail: 'installed' }); return; }
      resolve({ ok: false, detail: stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `npm exited with code ${code}` });
    });
  });
}
