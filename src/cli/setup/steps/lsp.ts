import * as p from '../../ui/prompts.js';
import { commandExists, serverForLanguage } from '../../../lsp/servers.js';
import { npmInstallGlobal } from '../../../lsp/install.js';
import { apiJson } from '../http.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** What `elowen setup` offers to install for out-of-the-box diagnostics: the TypeScript/JavaScript
 *  language server (plus the `typescript` package it drives). Other languages' servers ship with their
 *  own toolchains (pyright, gopls, rust-analyzer, …) and are surfaced in the CLI's /lsp modal instead.
 *  Command, packages and hint come from the ONE server catalog (src/lsp/servers.ts). */
const TS_SPEC = serverForLanguage('typescript')!;
export const TS_SERVER_COMMAND = TS_SPEC.command;

/** Human-readable install command, shown as the hint and in the "do it later" tip. */
export const TS_SERVER_INSTALL_HINT = TS_SPEC.installHint;

/** Install the TypeScript server. Prefers the DAEMON route (POST /brain/lsp/install): the daemon
 *  resolves servers from ITS OWN prefix, and the wizard may run as a different user — a local npm
 *  install could land where the daemon never looks, reporting success for a server it can't spawn.
 *  `verified:true` means the daemon confirmed the binary resolves on ITS side (skip local re-checks).
 *  Falls back to a local install only when the daemon is unreachable. */
export async function installTsServer(ctx?: WizardCtx): Promise<{ ok: boolean; detail: string; verified?: boolean }> {
  if (ctx) {
    try {
      const r = await apiJson<{ message?: string; error?: string }>(ctx, 'POST', '/brain/lsp/install', { command: TS_SERVER_COMMAND });
      if (r.ok) return { ok: true, detail: r.data?.message ?? 'installed', verified: true };
      return { ok: false, detail: r.data?.error ?? `daemon answered ${r.status}` };
    } catch { /* daemon unreachable — fall back to a local install */ }
  }
  return npmInstallGlobal(TS_SPEC.npmPackages ?? [TS_SPEC.command]);
}

/** Injected so the step is unit-testable without touching PATH or actually running npm. */
export interface LspStepDeps {
  exists: (command: string) => boolean;
  install: (ctx: WizardCtx) => Promise<{ ok: boolean; detail: string; verified?: boolean }>;
}
const defaultDeps: LspStepDeps = { exists: commandExists, install: (ctx) => installTsServer(ctx) };

/** Step 5 — code intelligence. Offers to install the TypeScript language server globally so the agent
 *  can type-check its own edits (the LspDiagnostics tool) out of the box. Local-only (no daemon call)
 *  and fully optional. */
export async function runLspStep(ctx: WizardCtx, deps: LspStepDeps = defaultDeps): Promise<StepResult> {
  p.note('Elowen can type-check its own edits live through language servers (LSP). Optional.', 'Code intelligence');

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
  const r = await deps.install(ctx);
  if (r.ok && (r.verified || deps.exists(TS_SERVER_COMMAND))) {
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
