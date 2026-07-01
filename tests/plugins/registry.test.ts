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
});
