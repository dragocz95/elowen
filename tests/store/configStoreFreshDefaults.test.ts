import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** The fresh-install default tool plugins — a SAFE set that needs no config to load (files, terminal,
 *  askuser, runtime-context, skills, subagent). Verified against each plugin's own manifest below so
 *  this list can never silently drift from what actually loads with zero config. */
const SAFE_DEFAULT_PLUGINS = ['files', 'terminal', 'askuser', 'runtime-context', 'skills', 'subagent'];

describe('ConfigStore fresh-install defaults', () => {
  it('plugins.enabled is exactly the safe out-of-box tool set on a brand-new (empty) config row', () => {
    const cfg = new ConfigStore(openDb(':memory:'));
    expect(cfg.get().plugins.enabled).toEqual(SAFE_DEFAULT_PLUGINS);
    expect(cfg.get().plugins.removed).toEqual([]);
  });

  it('never rewrites an existing install: an unrelated patch on a pre-existing row leaves plugins.enabled untouched', () => {
    const cfg = new ConfigStore(openDb(':memory:'));
    cfg.update({ plugins: { enabled: ['files'], removed: [] } }); // simulate an existing install's own choice
    cfg.update({ autoUpdate: true }); // unrelated patch
    expect(cfg.get().plugins.enabled).toEqual(['files']);
  });

  it('lspEnabled defaults to true, and a persisted "off" survives unrelated patches (restart-safe toggle)', () => {
    const cfg = new ConfigStore(openDb(':memory:'));
    expect(cfg.get().lspEnabled).toBe(true); // fresh install: diagnostics on
    cfg.update({ lspEnabled: false }); // the /lsp toggle persists off
    expect(cfg.get().lspEnabled).toBe(false);
    cfg.update({ autoUpdate: true }); // unrelated patch must not flip it back
    expect(cfg.get().lspEnabled).toBe(false);
    cfg.update({ lspEnabled: true });
    expect(cfg.get().lspEnabled).toBe(true);
  });
});

describe('SAFE_DEFAULT_PLUGINS load with no required config field', () => {
  for (const name of SAFE_DEFAULT_PLUGINS) {
    it(`${name}: no configSchema field is required`, () => {
      const manifestPath = join(process.cwd(), 'plugins', name, 'elowen-plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { configSchema?: { key: string; required?: boolean }[] };
      const required = (manifest.configSchema ?? []).filter((f) => f.required);
      expect(required).toEqual([]);
    });
  }
});
