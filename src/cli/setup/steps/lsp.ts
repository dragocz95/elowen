import * as p from '../../ui/prompts.js';
import type { LspServerView, LspStatus } from '../../chat/brainClient.js';
import { apiJson } from '../http.js';
import { guard, type StepResult, type WizardCtx } from '../types.js';

/** What `elowen setup` offers to install for out-of-the-box diagnostics: the TypeScript/JavaScript
 *  language server. Other languages' servers ship with their own toolchains (pyright, gopls,
 *  rust-analyzer, …) and are surfaced in the CLI's /lsp modal instead.
 *
 *  The catalog itself lives in the `lsp` plugin (daemon-side) since the extraction, so this step asks
 *  the DAEMON — GET /brain/lsp for the server row (installed? installable? install hint?) and POST
 *  /brain/lsp/install to install it. That is also the only correct place to ask: the daemon resolves
 *  servers from ITS OWN prefix, and the wizard may run as a different user, so a local PATH probe or a
 *  local npm install could report success for a server the daemon can never spawn. Only the binary NAME
 *  is spelled here — it is what identifies the row and the install target on the wire. */
export const TS_SERVER_COMMAND = 'typescript-language-server';

/** The daemon's row for the TypeScript server, or a reason it cannot be reported (plugin disabled,
 *  daemon unreachable, server unknown to this daemon). Never guesses. */
export async function tsServerRow(ctx: WizardCtx): Promise<{ row: LspServerView } | { error: string }> {
  let r: { ok: boolean; status: number; data: LspStatus | null };
  try { r = await apiJson<LspStatus>(ctx, 'GET', '/brain/lsp'); }
  catch { return { error: 'the daemon is not reachable' }; }
  if (r.status === 503) return { error: 'the lsp plugin is disabled on this daemon' };
  if (!r.ok || !r.data) return { error: `the daemon answered ${r.status}` };
  const row = r.data.servers.find((s) => s.command === TS_SERVER_COMMAND);
  return row ? { row } : { error: 'this daemon has no TypeScript language server registered' };
}

/** Install the TypeScript server daemon-side. Resolves — never rejects — so the step can report the
 *  failure instead of crashing the wizard. */
export async function installTsServer(ctx: WizardCtx): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await apiJson<{ message?: string; error?: string }>(ctx, 'POST', '/brain/lsp/install', { command: TS_SERVER_COMMAND });
    if (r.ok) return { ok: true, detail: r.data?.message ?? 'installed' };
    return { ok: false, detail: r.data?.error ?? `daemon answered ${r.status}` };
  } catch { return { ok: false, detail: 'the daemon is not reachable' }; }
}

/** Injected so the step is unit-testable without a daemon. */
export interface LspStepDeps {
  status: (ctx: WizardCtx) => Promise<{ row: LspServerView } | { error: string }>;
  install: (ctx: WizardCtx) => Promise<{ ok: boolean; detail: string }>;
}
const defaultDeps: LspStepDeps = { status: tsServerRow, install: installTsServer };

/** Step 5 — code intelligence. Offers to install the TypeScript language server so the agent can
 *  type-check its own edits (the LspDiagnostics tool) out of the box. Fully optional: anything that
 *  stops it (no daemon, plugin off, npm failure) reports the reason and skips. */
export async function runLspStep(ctx: WizardCtx, deps: LspStepDeps = defaultDeps): Promise<StepResult> {
  p.note('Elowen can type-check its own edits live through language servers (LSP). Optional.', 'Code intelligence');

  const probe = await deps.status(ctx);
  if ('error' in probe) {
    p.log.warn(`Skipping code intelligence — ${probe.error}.`);
    return skip(ctx);
  }
  const { row } = probe;

  if (row.installed) {
    p.log.success(`${TS_SERVER_COMMAND} is already installed.`);
    ctx.answers.lsp = { status: 'done', summary: `${TS_SERVER_COMMAND} installed` };
    return { status: 'done' };
  }
  if (!row.installable) {
    p.log.warn(`Elowen cannot install ${row.label} itself — ${row.installHint}.`);
    return skip(ctx);
  }

  const choice = guard(await p.select({
    message: 'Install the TypeScript/JavaScript language server?',
    options: [
      { value: 'install', label: 'Install now', hint: row.installHint },
      { value: 'skip', label: 'Skip for now' },
      { value: 'back', label: '← Go back' },
    ],
  })) as string;
  if (choice === 'back') return { status: 'back' };
  if (choice === 'skip') return skip(ctx);

  const s = p.spinner();
  s.start(`Installing ${TS_SERVER_COMMAND} (npm)…`);
  const r = await deps.install(ctx);
  if (r.ok) {
    // The daemon only answers ok after it re-resolved the binary in its own prefix, so this is a
    // verified install, not an npm exit code taken on trust.
    s.stop(`${TS_SERVER_COMMAND} installed.`);
    ctx.answers.lsp = { status: 'done', summary: `${TS_SERVER_COMMAND} installed` };
    return { status: 'done' };
  }
  s.stop(`Install failed: ${r.detail}`, 'error');
  p.log.warn(`You can install it later: ${row.installHint} (or from the /lsp modal).`);
  return skip(ctx);
}

function skip(ctx: WizardCtx): StepResult {
  ctx.answers.lsp = { status: 'skipped', summary: 'not installed' };
  return { status: 'skipped' };
}
