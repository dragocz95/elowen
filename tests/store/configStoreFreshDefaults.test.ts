import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** The fresh-install default tool plugins — a SAFE set that needs no config to load (files, terminal,
 *  askuser, runtime-context, skills, subagent, elowen-docs). Verified against each plugin's own manifest
 *  below so this list can never silently drift from what actually loads with zero config.
 *
 *  elowen-docs qualifies despite reading embeddings: the manual it searches ships with the install, and
 *  with no embedding model configured it ranks by keyword instead of failing — so it still answers "how
 *  do I set this up?" on the fresh install where nothing is set up yet.
 *
 *  agents qualifies too: it replaces the formerly-core tmux-agent/mission subsystem, needs no config
 *  field to load, and every optional capability (relay, PR mode) degrades the same way it did in core.
 *  So does lsp, the formerly-core language-server subsystem: no config field, and a language whose
 *  server is not installed degrades to an honest "not installed" exactly as it did in core. */
const SAFE_DEFAULT_PLUGINS = ['files', 'terminal', 'askuser', 'runtime-context', 'skills', 'subagent', 'elowen-docs', 'cronjob', 'security-scan', 'statusline', 'codebase', 'mcp', 'agents', 'lsp', 'editor'];

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

  it('the live-diagnostics toggle is the lsp plugin\'s config slice, and a persisted "off" survives unrelated patches', () => {
    const cfg = new ConfigStore(openDb(':memory:'));
    // The core `lspEnabled` field is gone from the public view AND from ConfigPatch: the plugin owns it.
    expect('lspEnabled' in (cfg.get() as Record<string, unknown>)).toBe(false);
    expect(cfg.pluginConfig('lsp')).toEqual({}); // fresh install: unset → the plugin's own default (on)
    cfg.update({ plugins: { config: { lsp: { diagnosticsEnabled: false } } } }); // the /lsp toggle persists off
    expect(cfg.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: false });
    cfg.update({ autoUpdate: true }); // unrelated patch must not flip it back
    expect(cfg.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: false });
    cfg.update({ plugins: { config: { lsp: { diagnosticsEnabled: true } } } });
    expect(cfg.pluginConfig('lsp')).toEqual({ diagnosticsEnabled: true });
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
