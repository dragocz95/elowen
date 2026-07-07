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

    it('refuses a name that shadows a built-in, a bad name, an empty prompt, or another plugin\'s name', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const log = { info() {}, warn: (m: string) => warns.push(m), error() {} };
      const ctx = reg.contextFor('p', {}, log);
      ctx.registerCommand({ name: 'help', description: 'x', prompt: 'y' });        // shadows built-in
      ctx.registerCommand({ name: 'Bad Name', description: 'x', prompt: 'y' });    // not kebab-case
      ctx.registerCommand({ name: 'ok-cmd', description: 'x', prompt: '   ' });    // empty prompt
      ctx.registerCommand({ name: 'ok-cmd', description: 'x', prompt: 'real' });   // valid
      reg.contextFor('other', {}, log).registerCommand({ name: 'ok-cmd', description: 'x', prompt: 'z' }); // collision
      expect(reg.commands.has('help')).toBe(false);
      expect(reg.commands.has('bad name')).toBe(false);
      expect(reg.commands.get('ok-cmd')?.prompt).toBe('real');
      expect(reg.commandOwner.get('ok-cmd')).toBe('p'); // first writer keeps it
      expect(warns.length).toBe(4);
    });

    it('merges plugin commands from a staged registry', () => {
      const base = new PluginRegistry();
      const staged = new PluginRegistry();
      staged.contextFor('x', {}, noopLog).registerCommand({ name: 'lint', description: 'x', prompt: 'lint' });
      base.merge(staged);
      expect(base.commands.get('lint')?.prompt).toBe('lint');
      expect(base.commandOwner.get('lint')).toBe('x');
    });
  });
});
