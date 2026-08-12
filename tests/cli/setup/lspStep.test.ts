import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { runLspStep, TS_SERVER_COMMAND, type LspStepDeps } from '../../../src/cli/setup/steps/lsp.js';
import type { LspServerView } from '../../../src/cli/chat/brainClient.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The step drives Elowen's prompt adapter; only `select` matters here (install / skip / back).
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  select: vi.fn(),
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  note: () => {},
  isCancel: () => false,
}));
import * as p from '../../../src/cli/ui/prompts.js';

const ctx = (): WizardCtx => ({ base: 'http://x', fetchFn: fetch, answers: {} });

/** The daemon's row for the TypeScript server, as GET /brain/lsp reports it. */
const row = (over: Partial<LspServerView> = {}): LspServerView => ({
  language: 'typescript', label: 'TypeScript', command: TS_SERVER_COMMAND,
  installed: false, running: false, installable: true,
  installHint: 'npm install -g typescript-language-server typescript',
  ...over,
});

const deps = (over: Partial<LspStepDeps> = {}): LspStepDeps => ({
  status: async () => ({ row: row() }),
  install: vi.fn(async () => ({ ok: true, detail: 'installed' })),
  ...over,
});

describe('cli/setup wizard LSP step', () => {
  // vi.mock hoists ONE `select` mock for the whole file, so its call log carries from test to test. The
  // first case asserts it was never called, which only held because it happened to run first — under a
  // different order (vitest --sequence.shuffle, or simply another worker interleaving) it saw the calls
  // the other cases made.
  beforeEach(() => { vi.clearAllMocks(); });

  it('completes immediately (no prompt, no install) when the daemon already has the server', async () => {
    const c = ctx();
    const install = vi.fn();
    const r = await runLspStep(c, deps({ status: async () => ({ row: row({ installed: true }) }), install }));
    expect(r.status).toBe('done');
    expect(c.answers.lsp).toEqual({ status: 'done', summary: `${TS_SERVER_COMMAND} installed` });
    expect(install).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('installs on request through the daemon and marks the step done', async () => {
    (p.select as Mock).mockResolvedValueOnce('install');
    const c = ctx();
    const install = vi.fn(async () => ({ ok: true, detail: 'TypeScript installed.' }));
    const r = await runLspStep(c, deps({ install }));
    expect(install).toHaveBeenCalledOnce();
    expect(r.status).toBe('done');
    expect(c.answers.lsp?.status).toBe('done');
  });

  it('a failed install degrades to skipped (never crashes the wizard)', async () => {
    (p.select as Mock).mockResolvedValueOnce('install');
    const c = ctx();
    const r = await runLspStep(c, deps({ install: async () => ({ ok: false, detail: 'EACCES' }) }));
    expect(r.status).toBe('skipped');
    expect(c.answers.lsp).toEqual({ status: 'skipped', summary: 'not installed' });
  });

  // The reason the step is daemon-driven: with no daemon (or no lsp plugin) nothing can be verified, so
  // it must skip WITH the reason rather than run a local install the daemon would never resolve.
  it('skips with the reason when the daemon cannot report (unreachable / lsp plugin disabled)', async () => {
    const c = ctx();
    const install = vi.fn();
    const r = await runLspStep(c, deps({ status: async () => ({ error: 'the lsp plugin is disabled on this daemon' }), install }));
    expect(r.status).toBe('skipped');
    expect(install).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('never offers to install a server that ships with its own toolchain', async () => {
    const c = ctx();
    const install = vi.fn();
    const r = await runLspStep(c, deps({ status: async () => ({ row: row({ installable: false }) }), install }));
    expect(r.status).toBe('skipped');
    expect(install).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('supports skip and back like every other step', async () => {
    (p.select as Mock).mockResolvedValueOnce('skip');
    const c = ctx();
    expect((await runLspStep(c, deps())).status).toBe('skipped');
    expect(c.answers.lsp?.summary).toBe('not installed');

    (p.select as Mock).mockResolvedValueOnce('back');
    expect((await runLspStep(ctx(), deps())).status).toBe('back');
  });
});
