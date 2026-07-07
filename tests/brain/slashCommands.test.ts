import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS, commandsFor, commandsWithPlugins, expandPromptCommand, isBuiltinCommand, findCommand } from '../../src/brain/slashCommands.js';

describe('slash command registry', () => {
  it('exposes the core commands', () => {
    for (const n of ['new', 'stop', 'status', 'compact', 'plan', 'build', 'model', 'think', 'restart', 'help']) {
      expect(findCommand(n), n).toBeDefined();
    }
  });

  it('hides admin-only commands from non-operators', () => {
    const restart = findCommand('restart')!;
    expect(restart.adminOnly).toBe(true);
    expect(commandsFor('web', false).some((c) => c.name === 'restart')).toBe(false);
    expect(commandsFor('web', true).some((c) => c.name === 'restart')).toBe(true);
  });

  it('scopes the CLI conversation pickers to the CLI surface only', () => {
    for (const n of ['sessions', 'resume', 'delete', 'quit']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
      expect(commandsFor('web', true).some((c) => c.name === n), `web ${n}`).toBe(false);
    }
  });

  it('publishes stop/status/compact to every surface', () => {
    for (const surface of ['cli', 'discord', 'web'] as const) {
      for (const n of ['stop', 'status', 'compact']) {
        expect(commandsFor(surface, true).some((c) => c.name === n), `${surface} ${n}`).toBe(true);
      }
    }
  });

  it('scopes /think to the CLI (the only surface that wires the reasoning picker)', () => {
    expect(commandsFor('cli', true).some((c) => c.name === 'think')).toBe(true);
    expect(commandsFor('web', true).some((c) => c.name === 'think')).toBe(false);
    expect(commandsFor('discord', true).some((c) => c.name === 'think')).toBe(false);
  });

  it('scopes local work modes to the CLI surface', () => {
    for (const n of ['plan', 'build']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('web', true).some((c) => c.name === n), `web ${n}`).toBe(false);
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
    }
  });

  it('every command has a non-empty English description', () => {
    for (const c of SLASH_COMMANDS) expect(c.description.trim().length, c.name).toBeGreaterThan(0);
  });

  describe('plugin-contributed prompt commands', () => {
    const plugin = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy to $1 with notes: $ARGS', plugin: 'ops' }];

    it('merges plugin commands after the built-ins for the surface', () => {
      const cli = commandsWithPlugins('cli', true, plugin);
      const deploy = cli.find((c) => c.name === 'deploy');
      expect(deploy).toMatchObject({ kind: 'prompt', prompt: 'Deploy to $1 with notes: $ARGS', plugin: 'ops' });
      // built-ins still present and come first
      expect(cli.findIndex((c) => c.name === 'help')).toBeLessThan(cli.findIndex((c) => c.name === 'deploy'));
    });

    it('never lets a plugin command shadow a built-in', () => {
      const merged = commandsWithPlugins('cli', true, [{ name: 'help', description: 'x', prompt: 'y' }]);
      expect(merged.filter((c) => c.name === 'help')).toHaveLength(1);
      expect(merged.find((c) => c.name === 'help')?.kind).toBe('info');
      expect(isBuiltinCommand('help')).toBe(true);
      expect(isBuiltinCommand('deploy')).toBe(false);
    });

    it('respects a plugin command surface restriction', () => {
      const cliOnly = [{ name: 'lint', description: 'x', prompt: 'lint it', surfaces: ['cli' as const] }];
      expect(commandsWithPlugins('cli', true, cliOnly).some((c) => c.name === 'lint')).toBe(true);
      expect(commandsWithPlugins('web', true, cliOnly).some((c) => c.name === 'lint')).toBe(false);
    });
  });

  describe('expandPromptCommand', () => {
    it('substitutes $ARGS with the whole argument string', () => {
      expect(expandPromptCommand('Fix: $ARGS', 'the login bug')).toBe('Fix: the login bug');
    });
    it('substitutes positional $1..$9', () => {
      expect(expandPromptCommand('$1 then $2', 'alpha beta')).toBe('alpha then beta');
      expect(expandPromptCommand('$1 / $2', 'solo')).toBe('solo /');
    });
    it('appends arguments when the template uses no placeholders', () => {
      expect(expandPromptCommand('Run the review checklist.', 'src/app.ts')).toBe('Run the review checklist.\n\nsrc/app.ts');
    });
    it('leaves a placeholder-free template untouched with no arguments', () => {
      expect(expandPromptCommand('Summarize the diff.', '')).toBe('Summarize the diff.');
    });
    it('inserts $-sequences in the arguments literally (no replacement-pattern interpretation)', () => {
      // `$$`, `$&`, `$1` inside the user's args must NOT be interpreted, and the $ARGS output must not be
      // re-scanned by the positional pass (single-pass function replacer).
      expect(expandPromptCommand('Note: $ARGS', 'price is $$100 and $9 total')).toBe('Note: price is $$100 and $9 total');
      expect(expandPromptCommand('$1', '$&')).toBe('$&');
    });
  });

  it('gates /lsp behind adminOnly (daemon-wide toggle)', () => {
    const lsp = findCommand('lsp')!;
    expect(lsp.adminOnly).toBe(true);
    expect(commandsFor('cli', false).some((c) => c.name === 'lsp')).toBe(false);
    expect(commandsFor('cli', true).some((c) => c.name === 'lsp')).toBe(true);
  });
});
