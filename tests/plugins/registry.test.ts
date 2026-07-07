import { describe, it, expect } from 'vitest';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { PluginSkill } from '../../src/plugins/api.js';

const noopLog = { info() {}, warn() {}, error() {} };
const fakeSkill = (name: string) => ({ name, description: 'd', filePath: `/s/${name}.md` } as unknown as PluginSkill);

describe('PluginRegistry', () => {
  it('collects contributions from a register() call', () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', { k: 1 }, noopLog);
    ctx.registerSkill(fakeSkill('s'));
    ctx.registerSystemPromptFragment('extra rules');
    ctx.registerHook({ name: 'h', run: () => {} });
    expect(reg.skills.map((s) => s.name)).toEqual(['s']);
    expect(reg.promptFragments).toEqual(['extra rules']);
    expect(reg.hooks).toHaveLength(1);
    expect(ctx.config).toEqual({ k: 1 });
  });

  it('isolates each plugin config slice', () => {
    const reg = new PluginRegistry();
    const a = reg.contextFor('a', { v: 'a' }, noopLog);
    const b = reg.contextFor('b', { v: 'b' }, noopLog);
    expect(a.config).toEqual({ v: 'a' });
    expect(b.config).toEqual({ v: 'b' });
  });

  it('prefixes the scoped logger with the plugin name', () => {
    const lines: string[] = [];
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('skills', {}, { info: (m) => lines.push(m), warn() {}, error() {} });
    ctx.logger.info('loaded');
    expect(lines).toEqual(['[plugin:skills] loaded']);
  });

  describe('registerCommand', () => {
    it('accepts a valid kebab-case prompt command and tracks its owner', () => {
      const reg = new PluginRegistry();
      reg.contextFor('ops', {}, noopLog).registerCommand({ name: 'deploy', description: 'Ship', prompt: 'Deploy $ARGS' });
      expect(reg.commands.get('deploy')).toMatchObject({ name: 'deploy', prompt: 'Deploy $ARGS' });
      expect(reg.commandOwner.get('deploy')).toBe('ops');
    });

    it('refuses a name that shadows a built-in, is malformed, or has an empty prompt', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const log = { info() {}, warn: (m: string) => warns.push(m), error() {} };
      const ctx = reg.contextFor('p', {}, log);
      ctx.registerCommand({ name: 'help', description: 'x', prompt: 'y' });        // shadows built-in
      ctx.registerCommand({ name: 'Bad Name', description: 'x', prompt: 'y' });    // not kebab-case
      ctx.registerCommand({ name: 'ok-cmd', description: 'x', prompt: '   ' });    // empty prompt
      ctx.registerCommand({ name: 'ok-cmd', description: 'x', prompt: 'real' });   // valid (overrides self)
      expect(reg.commands.has('help')).toBe(false);
      expect(reg.commands.has('bad name')).toBe(false);
      expect(reg.commands.get('ok-cmd')?.prompt).toBe('real');
      expect(reg.commandOwner.get('ok-cmd')).toBe('p');
      expect(warns.length).toBe(3);
    });

    it('accepts a single-character command name (regex allows 1–32 chars)', () => {
      const reg = new PluginRegistry();
      reg.contextFor('p', {}, noopLog).registerCommand({ name: 'x', description: 'x', prompt: 'y' });
      expect(reg.commands.has('x')).toBe(true);
    });

    it('merges plugin commands from a staged registry', () => {
      const base = new PluginRegistry();
      const staged = new PluginRegistry();
      staged.contextFor('x', {}, noopLog).registerCommand({ name: 'lint', description: 'x', prompt: 'lint' });
      base.merge(staged);
      expect(base.commands.get('lint')?.prompt).toBe('lint');
      expect(base.commandOwner.get('lint')).toBe('x');
    });

    it('enforces first-writer-wins for a cross-plugin command collision at merge()', () => {
      const warns: string[] = [];
      const base = new PluginRegistry();
      const a = new PluginRegistry();
      a.contextFor('a', {}, noopLog).registerCommand({ name: 'dup', description: 'x', prompt: 'A' });
      const b = new PluginRegistry();
      b.contextFor('b', {}, noopLog).registerCommand({ name: 'dup', description: 'x', prompt: 'B' });
      base.merge(a);
      base.merge(b, (m) => warns.push(m));
      expect(base.commands.get('dup')?.prompt).toBe('A'); // the first plugin keeps the name
      expect(base.commandOwner.get('dup')).toBe('a');
      expect(warns.some((w) => w.includes('dup'))).toBe(true);
    });

    it('enforces first-writer-wins for a cross-plugin control collision at merge()', () => {
      const warns: string[] = [];
      const base = new PluginRegistry();
      const a = new PluginRegistry();
      a.contextFor('a', {}, noopLog).registerControl('mcp', { schema: {}, handler: async () => ({}) } as never);
      const b = new PluginRegistry();
      b.contextFor('b', {}, noopLog).registerControl('mcp', { schema: {}, handler: async () => ({}) } as never);
      base.merge(a);
      base.merge(b, (m) => warns.push(m));
      expect(base.controlOwner.get('mcp')).toBe('a');
      expect(warns.some((w) => w.includes('mcp'))).toBe(true);
    });
  });
});
