import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { ConfigStore } from '../../src/store/configStore.js';

/** The fresh-install default plugin set — a BARE ASSISTANT: tools that need no configuration to be
 *  useful (files, terminal, askuser, runtime-context, subagent, elowen-docs, statusline, mcp, lsp). Every entry is checked against its own manifest below, so this list can never
 *  silently drift from what actually ships on.
 *
 *  elowen-docs qualifies despite reading embeddings: the manual it searches ships with the install, and
 *  with no embedding model configured it ranks by keyword instead of failing — so it still answers "how
 *  do I set this up?" on the fresh install where nothing is set up yet. lsp qualifies the same way: a
 *  language whose server is not installed degrades to an honest "not installed".
 *
 *  Extensions that carry no daemon dependency are not here at all — they ship from the plugin registry,
 *  so a fresh install does not have them on disk to enable. */
const SAFE_DEFAULT_PLUGINS = ['files', 'terminal', 'askuser', 'runtime-context', 'subagent', 'elowen-docs', 'statusline', 'mcp', 'lsp'];

interface Manifest {
  configSchema?: { key: string; required?: boolean }[];
  web?: { label?: string; nav?: { label: string; route?: string }[] };
}

function manifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'plugins', name, 'elowen-plugin.json'), 'utf-8')) as Manifest;
}

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
      const required = (manifest(name).configSchema ?? []).filter((f) => f.required);
      expect(required).toEqual([]);
    });
  }
});

/** The rule a fresh install must satisfy, derived MECHANICALLY from each manifest rather than from a
 *  name list somebody has to remember to update: a plugin that contributes its own pages to the main
 *  navigation (`web.nav`) owns a domain vertical — its own world in the dashboard, its own objects, its
 *  own lifecycle (agents → Sessions/Escalations, work → Tasks/Kanban/Timeline/Stats, editor → Editor).
 *  Elowen out of the box is an assistant, not somebody else's product, so none of those ship enabled;
 *  the owner installs them from Settings → Plugins. A plugin contributing only a SETTINGS section
 *  (subagent) configures the assistant itself and is fine. */
describe('a fresh install enables no plugin that owns a domain vertical', () => {
  const cfg = new ConfigStore(openDb(':memory:'));
  const enabled = cfg.get().plugins.enabled;

  for (const name of enabled) {
    it(`${name}: contributes no top-level navigation of its own`, () => {
      const web = manifest(name).web;
      expect(web?.nav ?? []).toEqual([]);
      expect(web?.label ?? null).toBeNull(); // `label` names a plugin's nav WORLD — same signal
    });
  }

  it('the plugins that do own one are absent from the fresh set (and are the ones the rule catches)', () => {
    const vertical = ['agents', 'work', 'editor'].filter((n) => (manifest(n).web?.nav ?? []).length > 0);
    expect(vertical).toEqual(['agents', 'work', 'editor']); // guard: they still declare nav
    for (const name of vertical) expect(enabled).not.toContain(name);
  });
});

/** The other half of the promise: trimming the fresh defaults must not take anything away from an
 *  install that already has it. Those installs keep their subsystems through the one-shot migrations,
 *  which run only when a settings row already exists. */
describe('existing installs keep their domain plugins across the upgrade', () => {
  it('a pre-existing row that predates the extraction still gets agents/work/editor enabled', () => {
    const db = openDb(':memory:');
    // A settings row written before the subsystems were extracted: no migration markers at all.
    db.prepare('INSERT INTO settings (id, data) VALUES (1, ?)').run(JSON.stringify({
      allowedExecs: ['sonnet'],
      plugins: { enabled: ['files', 'terminal'], removed: [], config: {} },
    }));

    const upgraded = new ConfigStore(db);
    upgraded.migrateAgentsEnabled();
    upgraded.migrateEditorPlugin();
    upgraded.migrateWorkPlugin();

    expect(upgraded.get().plugins.enabled).toEqual(['files', 'terminal', 'agents', 'editor', 'work']);
  });

  it('a FRESH install is never handed one by those same sweeps (the markers ship set)', () => {
    const cfg = new ConfigStore(openDb(':memory:'));
    cfg.update({ autoUpdate: true }); // materialise the fresh row exactly as a first boot does
    cfg.migrateAgentsEnabled();
    cfg.migrateEditorPlugin();
    cfg.migrateWorkPlugin();
    expect(cfg.get().plugins.enabled).toEqual(SAFE_DEFAULT_PLUGINS);
  });
});
