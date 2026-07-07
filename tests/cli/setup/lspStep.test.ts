import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { runLspStep, TS_SERVER_COMMAND } from '../../../src/cli/setup/steps/lsp.js';
import type { WizardCtx } from '../../../src/cli/setup/types.js';

// The step drives Orca's prompt adapter; only `select` matters here (install / skip / back).
vi.mock('../../../src/cli/ui/prompts.js', () => ({
  select: vi.fn(),
  spinner: () => ({ start: () => {}, stop: () => {} }),
  log: { info: () => {}, success: () => {}, error: () => {}, warn: () => {}, step: () => {}, message: () => {} },
  note: () => {},
  isCancel: () => false,
}));
import * as p from '../../../src/cli/ui/prompts.js';

const ctx = (): WizardCtx => ({ base: 'http://x', fetchFn: fetch, answers: {} });

describe('cli/setup wizard LSP step', () => {
  it('completes immediately (no prompt, no install) when the server is already on PATH', async () => {
    const c = ctx();
    const install = vi.fn();
    const r = await runLspStep(c, { exists: () => true, install });
    expect(r.status).toBe('done');
    expect(c.answers.lsp).toEqual({ status: 'done', summary: `${TS_SERVER_COMMAND} installed` });
    expect(install).not.toHaveBeenCalled();
    expect(p.select).not.toHaveBeenCalled();
  });

  it('installs on request and marks the step done once the binary appears on PATH', async () => {
    (p.select as Mock).mockResolvedValueOnce('install');
    const c = ctx();
    let installed = false;
    const install = vi.fn(async () => { installed = true; return { ok: true, detail: 'installed' }; });
    const r = await runLspStep(c, { exists: () => installed, install });
    expect(install).toHaveBeenCalledOnce();
    expect(r.status).toBe('done');
    expect(c.answers.lsp?.status).toBe('done');
  });

  it('a failed npm install degrades to skipped (never crashes the wizard)', async () => {
    (p.select as Mock).mockResolvedValueOnce('install');
    const c = ctx();
    const r = await runLspStep(c, { exists: () => false, install: async () => ({ ok: false, detail: 'EACCES' }) });
    expect(r.status).toBe('skipped');
    expect(c.answers.lsp).toEqual({ status: 'skipped', summary: 'not installed' });
  });

  it('an install that lands off-PATH is reported as skipped, not a false success', async () => {
    (p.select as Mock).mockResolvedValueOnce('install');
    const c = ctx();
    const r = await runLspStep(c, { exists: () => false, install: async () => ({ ok: true, detail: 'installed' }) });
    expect(r.status).toBe('skipped');
  });

  it('supports skip and back like every other step', async () => {
    (p.select as Mock).mockResolvedValueOnce('skip');
    const c = ctx();
    expect((await runLspStep(c, { exists: () => false, install: vi.fn() })).status).toBe('skipped');
    expect(c.answers.lsp?.summary).toBe('not installed');

    (p.select as Mock).mockResolvedValueOnce('back');
    expect((await runLspStep(ctx(), { exists: () => false, install: vi.fn() })).status).toBe('back');
  });
});
