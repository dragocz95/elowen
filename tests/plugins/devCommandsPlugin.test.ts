import { describe, it, expect } from 'vitest';
import { register } from '../../plugins/dev-commands/index.mjs';
import { buildPromptTemplates } from '../../src/brain/slashCommands.js';

interface Cmd { name: string; description: string; prompt: string }
function fakeCtx(config: Record<string, unknown> = {}) {
  const commands: Cmd[] = [];
  return { commands, ctx: { config, logger: { info() {}, warn() {}, error() {} }, registerCommand: (c: Cmd) => commands.push(c) } };
}

describe('dev-commands plugin', () => {
  it('registers the full curated set when no selection is configured', () => {
    const { commands, ctx } = fakeCtx();
    register(ctx);
    expect(commands.map((c) => c.name).sort()).toEqual(['commit', 'docs', 'explain', 'pr', 'review', 'test']);
    for (const c of commands) {
      expect(c.description.trim().length).toBeGreaterThan(0);
      expect(c.prompt).toContain('$ARGUMENTS'); // every macro takes an argument (PI's native placeholder)
    }
  });

  it('registers only the selected commands when configured', () => {
    const { commands, ctx } = fakeCtx({ enabled: ['commit', 'review'] });
    register(ctx);
    expect(commands.map((c) => c.name).sort()).toEqual(['commit', 'review']);
  });

  it('an empty selection falls back to all commands', () => {
    const { commands, ctx } = fakeCtx({ enabled: [] });
    register(ctx);
    expect(commands.length).toBe(6);
  });

  it('maps onto a PI PromptTemplate so PI expands the argument natively on send', () => {
    const { commands, ctx } = fakeCtx({ enabled: ['explain'] });
    register(ctx);
    const [tpl] = buildPromptTemplates(commands);
    // We copy the macro verbatim into PI's template content; PI substitutes $ARGUMENTS itself.
    expect(tpl.name).toBe('explain');
    expect(tpl.content).toBe(commands[0]!.prompt);
    expect(tpl.content).toContain('$ARGUMENTS');
  });
});
