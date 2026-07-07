import { spawn } from 'node:child_process';
import * as p from '../../ui/prompts.js';
import { commandExists } from '../../../lsp/servers.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** What `orca setup` offers to install for out-of-the-box diagnostics: the TypeScript/JavaScript
 *  language server (plus the `typescript` package it drives). Other languages' servers ship with their
 *  own toolchains (pyright, gopls, rust-analyzer, …) and are surfaced in the CLI's /lsp modal instead. */
export const TS_SERVER_COMMAND = 'typescript-language-server';
const TS_SERVER_PACKAGES = [TS_SERVER_COMMAND, 'typescript'];

/** Human-readable install command, shown as the hint and in the "do it later" tip. */
export const TS_SERVER_INSTALL_HINT = `npm install -g ${TS_SERVER_PACKAGES.join(' ')}`;

/** Run `npm install -g typescript-language-server typescript`. Array-argv spawn (never a shell string,
 *  so nothing gets re-parsed); npm on Windows is a `.cmd` shim, which does need the shell. Resolves —
 *  never rejects — with ok + a short failure detail (last stderr lines), so callers just branch. */
export function installTsServer(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'npm.cmd' : 'npm', ['install', '-g', ...TS_SERVER_PACKAGES], { stdio: ['ignore', 'ignore', 'pipe'], shell: win });
    let stderr = '';
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, detail: e.message }));
    child.on('exit', (code) => {
      if (code === 0) { resolve({ ok: true, detail: 'installed' }); return; }
      resolve({ ok: false, detail: stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `npm exited with code ${code}` });
    });
  });
}

/** Injected so the step is unit-testable without touching PATH or actually running npm. */
export interface LspStepDeps {
  exists: (command: string) => boolean;
  install: () => Promise<{ ok: boolean; detail: string }>;
}
const defaultDeps: LspStepDeps = { exists: commandExists, install: installTsServer };

/** Step 5 — code intelligence. Offers to install the TypeScript language server globally so the agent
 *  can type-check its own edits (the lsp_diagnostics tool) out of the box. Local-only (no daemon call)
 *  and fully optional. */
export async function runLspStep(ctx: WizardCtx, deps: LspStepDeps = defaultDeps): Promise<StepResult> {
  p.note('Orca can type-check its own edits live through language servers (LSP). Optional.', 'Code intelligence');

  if (deps.exists(TS_SERVER_COMMAND)) {
    p.log.success(`${TS_SERVER_COMMAND} is already installed.`);
    ctx.answers.lsp = { status: 'done', summary: `${TS_SERVER_COMMAND} installed` };
    return { status: 'done' };
  }

  const choice = guard(await p.select({
    message: 'Install the TypeScript/JavaScript language server?',
    options: [
      { value: 'install', label: 'Install now', hint: TS_SERVER_INSTALL_HINT },
      { value: 'skip', label: 'Skip for now' },
      { value: 'back', label: '← Go back' },
    ],
  })) as string;
  if (choice === 'back') return { status: 'back' };
  if (choice === 'skip') return skip(ctx);

  const s = p.spinner();
  s.start(`Installing ${TS_SERVER_COMMAND} (npm)…`);
  const r = await deps.install();
  if (r.ok && deps.exists(TS_SERVER_COMMAND)) {
    s.stop(`${TS_SERVER_COMMAND} installed.`);
    ctx.answers.lsp = { status: 'done', summary: `${TS_SERVER_COMMAND} installed` };
    return { status: 'done' };
  }
  // Either npm failed, or it "succeeded" into a global bin dir that isn't on PATH — both mean
  // diagnostics won't work yet, so report honestly instead of claiming success.
  s.stop(r.ok ? `Installed, but ${TS_SERVER_COMMAND} is not on PATH — check your npm global bin directory.` : `Install failed: ${r.detail}`, 'error');
  p.log.warn(`You can install it later: ${TS_SERVER_INSTALL_HINT} (may need sudo).`);
  return skip(ctx);
}

function skip(ctx: WizardCtx): StepResult {
  ctx.answers.lsp = { status: 'skipped', summary: 'not installed' };
  return { status: 'skipped' };
}
