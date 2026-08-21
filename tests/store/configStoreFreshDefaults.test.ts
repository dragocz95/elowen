import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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
const SAFE_DEFAULT_PLUGINS = ['files', 'terminal', 'askuser', 'runtime-context', 'subagent', 'elowen-docs', 'statusline', 'mcp'];

interface Manifest {
  configSchema?: { key: string; required?: boolean }[];
  web?: {
    label?: string;
    navKind?: 'domain' | 'infrastructure';
    nav?: { label: string; route?: string }[];
    settings?: { id: string }[];
  };
}

function manifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(process.cwd(), 'plugins', name, 'elowen-plugin.json'), 'utf-8')) as Manifest;
}

/** The rule itself, in one place so the fresh set below and the teeth check are measured by the SAME
 *  predicate — a rule that is re-spelled per test can be weakened in one copy and stay green in the
 *  other. Main-navigation pages are domain verticals by default: workflow worlds with their own objects
 *  and lifecycle. A manifest may explicitly classify a page as `infrastructure` only when it configures
 *  a capability the assistant already ships (MCP servers), rather than introducing a product workflow.
 *  That semantic marker is reviewable by future plugin authors; plugin names are deliberately irrelevant. */
const ownsVertical = (m: Manifest): boolean => (
  ((m.web?.nav?.length ?? 0) > 0 || (m.web?.label ?? null) !== null)
  && m.web?.navKind !== 'infrastructure'
);

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
 *  name list somebody has to remember to update. A main-navigation page is a domain vertical by default:
 *  its own workflow world, objects and lifecycle (agents → Sessions/Escalations, work →
 *  Tasks/Kanban/Timeline/Stats). Elowen out of the box is an assistant, not somebody else's product, so
 *  those stay opt-in. An explicitly `infrastructure` page is different: like a Settings section, it
 *  configures a capability the assistant already ships rather than adding a workflow product. */
describe('a fresh install enables no plugin that owns a domain vertical', () => {
  const cfg = new ConfigStore(openDb(':memory:'));
  const enabled = cfg.get().plugins.enabled;

  for (const name of enabled) {
    it(`${name}: owns no domain vertical`, () => {
      expect({ plugin: name, ownsVertical: ownsVertical(manifest(name)) }).toEqual({ plugin: name, ownsVertical: false });
    });
  }

  // Every default must be a plugin this package actually SHIPS — the loop above reads each manifest from
  // disk, so a default naming a plugin that is not here would make it throw rather than pass, but only
  // by accident. Stated outright it also holds the other half: a fresh install cannot enable a name the
  // installer has no folder for, which is how the departed plugins would have to come back.
  it('every fresh default is a plugin on disk', () => {
    const onDisk = readdirSync(join(process.cwd(), 'plugins'));
    expect(enabled.filter((name) => !onDisk.includes(name))).toEqual([]);
  });

  // agents, work and editor used to be the positive subjects. They moved to the registry, so the
  // discrimination is proved directly: a real settings-only bundled manifest stays allowed; MCP's real
  // explicitly-infrastructure page stays allowed; and a Tasks-shaped workflow world remains rejected by
  // default. The default matters: adding nav without making and reviewing a semantic classification can
  // never quietly turn a fresh-install plugin into an allowed exception.
  it('the rule still catches a plugin that owns a vertical', () => {
    const settingsOnly = manifest('subagent');
    expect(settingsOnly.web?.settings?.length ?? 0).toBeGreaterThan(0); // a real web block, not an absent one
    expect(ownsVertical(settingsOnly)).toBe(false); // configuring the assistant itself is fine

    const infrastructure = manifest('mcp');
    expect(infrastructure.web?.navKind).toBe('infrastructure');
    expect(infrastructure.web?.nav?.length ?? 0).toBeGreaterThan(0);
    expect(ownsVertical(infrastructure)).toBe(false);

    const tasksShaped = {
      ...settingsOnly,
      web: {
        ...settingsOnly.web,
        label: 'Tasks',
        nav: [
          { label: 'Kanban', route: '/kanban' },
          { label: 'Timeline', route: '/timeline' },
          { label: 'Statistics', route: '/stats' },
        ],
      },
    };
    expect(ownsVertical(tasksShaped)).toBe(true);

    // …and a plugin the rule catches is one the fresh set would then have to exclude.
    expect(enabled.filter((name) => ownsVertical(manifest(name)))).toEqual([]);
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
