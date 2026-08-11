import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { setPluginPromptCatalog, editablePrompts, isEditablePrompt, isAppendOnlyPrompt } from '../../src/prompts/catalog.js';
import { setPluginPromptSources, render, _resetPromptCache } from '../../src/prompts/index.js';

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
      { name: 'agents-brief', group: 'agents', vars: ['x'], jsonContract: false, appendOnly: true },
      { name: 'worker', group: 'agents', vars: [], jsonContract: true }, // core name — must be dropped
    ]);
    const all = editablePrompts();
    expect(all.filter((p) => p.name === 'worker')).toHaveLength(1);
    expect(all.find((p) => p.name === 'worker')?.group).toBe('workers');
    expect(isEditablePrompt('agents-brief')).toBe(true);
    expect(isAppendOnlyPrompt('agents-brief')).toBe(true);
    expect(isEditablePrompt('agents-missing')).toBe(false);
  });

  it('a plugin source shadows the core file and un-shadows on swap-out', () => {
    writeFileSync(join(tmp, 'pilot.md'), 'plugin pilot {{goal}}');
    const core = render('pilot', { goal: 'g' });
    expect(core).not.toContain('plugin pilot');
    setPluginPromptSources(new Map([['pilot', join(tmp, 'pilot.md')]]));
    expect(render('pilot', { goal: 'g' })).toBe('plugin pilot g');
    // Swap the overlay out again — the cache entry must drop with it, not pin the plugin text.
    setPluginPromptSources(new Map());
    expect(render('pilot', { goal: 'g' })).toBe(core);
  });
});
