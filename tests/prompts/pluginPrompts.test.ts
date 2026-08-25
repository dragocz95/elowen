import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { setPluginPromptCatalog, editablePrompts, isEditablePrompt, isAppendOnlyPrompt } from '../../src/prompts/catalog.js';
import { setPluginPromptSources, render, rawTemplate, applyVars, _resetPromptCache } from '../../src/prompts/index.js';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/store/db.js';
import { UserPromptStore } from '../../src/store/userPromptStore.js';
import { PromptService } from '../../src/prompts/promptService.js';

const noopLog = { info() {}, warn() {}, error() {} };

const tmp = mkdtempSync(join(tmpdir(), 'plugin-prompts-'));
afterEach(() => {
  setPluginPromptCatalog([]);
  setPluginPromptSources(new Map());
  _resetPromptCache();
});
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

describe('registerPrompts', () => {
  it('requires the mutates:[prompt] capability and an existing template file', () => {
    writeFileSync(join(tmp, 'greet.md'), 'Hello {{who}}');
    const reg = new PluginRegistry();
    const entries = [{ name: 'greet', group: 'demo', vars: ['who'], jsonContract: false }];
    const denied = reg.contextFor('demo', {}, noopLog);
    denied.registerPrompts({ dir: tmp, entries });
    expect(reg.promptEntries).toHaveLength(0);
    const warn = vi.fn();
    const granted = reg.contextFor('demo', {}, { info() {}, warn, error() {} }, undefined, undefined, undefined, undefined, { mutates: ['prompt'] });
    granted.registerPrompts({ dir: tmp, entries: [...entries, { name: 'missing', group: 'demo', vars: [], jsonContract: false }, { name: '../evil', group: 'demo', vars: [], jsonContract: false }] });
    expect(reg.promptEntries.map((p) => p.entry.name)).toEqual(['greet']);
    expect(reg.promptSources.get('greet')).toEqual({ plugin: 'demo', file: join(tmp, 'greet.md') });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no template file'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad template name'));
  });

  it('merge keeps the first plugin owning a colliding template name', () => {
    writeFileSync(join(tmp, 'shared.md'), 'A');
    const a = new PluginRegistry(); const b = new PluginRegistry();
    const entry = { name: 'shared', group: 'demo', vars: [], jsonContract: false };
    a.contextFor('a', {}, noopLog, undefined, undefined, undefined, undefined, { mutates: ['prompt'] }).registerPrompts({ dir: tmp, entries: [entry] });
    b.contextFor('b', {}, noopLog, undefined, undefined, undefined, undefined, { mutates: ['prompt'] }).registerPrompts({ dir: tmp, entries: [entry] });
    const merged = new PluginRegistry();
    const warn = vi.fn();
    merged.merge(a, warn); merged.merge(b, warn);
    expect(merged.promptEntries).toHaveLength(1);
    expect(merged.promptSources.get('shared')?.plugin).toBe('a');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already registered by "a"'));
  });
});

describe('prompt catalog + renderer overlay', () => {
  it('plugin entries extend the catalog but never displace a core entry', () => {
    setPluginPromptCatalog([
      { name: 'demo-brief', group: 'demo', vars: ['x'], jsonContract: false, appendOnly: true },
      { name: 'scheduled', group: 'demo', vars: [], jsonContract: true }, // core name — must be dropped
    ]);
    const all = editablePrompts();
    expect(all.filter((p) => p.name === 'scheduled')).toHaveLength(1);
    expect(all.find((p) => p.name === 'scheduled')?.group).toBe('advisor');
    expect(isEditablePrompt('demo-brief')).toBe(true);
    expect(isAppendOnlyPrompt('demo-brief')).toBe(true);
    expect(isEditablePrompt('demo-missing')).toBe(false);
  });

  it('a plugin source shadows the core file and un-shadows on swap-out', () => {
    writeFileSync(join(tmp, 'scheduled.md'), 'plugin scheduled {{agentName}}');
    const core = render('scheduled', { agentName: 'Ada' });
    expect(core).not.toContain('plugin scheduled');
    setPluginPromptSources(new Map([['scheduled', join(tmp, 'scheduled.md')]]));
    expect(render('scheduled', { agentName: 'Ada' })).toBe('plugin scheduled Ada');
    // Swap the overlay out again — the cache entry must drop with it, not pin the plugin text.
    setPluginPromptSources(new Map());
    expect(render('scheduled', { agentName: 'Ada' })).toBe(core);
  });
});

describe('a plugin template under the daemon\'s prompt service', () => {
  /** A template a plugin ships: registered into the catalog and sourced from ITS directory, exactly as
   *  the loader wires a real one. What the daemon owns is what happens around it — that the registered
   *  name resolves to the plugin's file, that it counts as editable, and that a per-user override in
   *  user_prompts still wins. Which templates any particular plugin ships is pinned beside it. */
  const installOverlay = () => {
    writeFileSync(join(tmp, 'crew.md'), 'Briefing for {{agentName}}');
    setPluginPromptCatalog([{ name: 'crew', group: 'demo', vars: ['agentName'], jsonContract: false }]);
    setPluginPromptSources(new Map([['crew', join(tmp, 'crew.md')]]));
  };

  it('the registered template resolves to the plugin file, byte-identical to disk, and is editable', () => {
    installOverlay();
    expect(rawTemplate('crew')).toBe(readFileSync(join(tmp, 'crew.md'), 'utf-8').trim());
    expect(isEditablePrompt('crew')).toBe(true);
  });

  it('a user override in user_prompts still wins over the plugin file', () => {
    installOverlay();
    const store = new UserPromptStore(openDb(':memory:'));
    const prompts = new PromptService(store);
    store.set(1, 'crew', 'my crew override for {{agentName}}');
    expect(prompts.render('crew', { agentName: 'Ada' }, 1)).toBe('my crew override for Ada');
    // Another user without an override gets the plugin file default.
    expect(prompts.render('crew', { agentName: 'Ada' }, 2)).toBe(applyVars(rawTemplate('crew'), { agentName: 'Ada' }));
  });
});
