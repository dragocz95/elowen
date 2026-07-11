import { describe, it, expect } from 'vitest';
import { SLASH_COMMANDS, commandsFor, commandsWithPlugins, buildPromptTemplates, isPromptCommand, isBuiltinCommand, findCommand } from '../../src/brain/slashCommands.js';

describe('slash command registry', () => {
  it('exposes the core commands', () => {
    for (const n of ['new', 'stop', 'status', 'compact', 'plan', 'build', 'model', 'fast', 'reasoning', 'rename', 'restart', 'help']) {
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
    for (const n of ['sessions', 'resume', 'rename', 'delete', 'quit']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
      expect(commandsFor('web', true).some((c) => c.name === n), `web ${n}`).toBe(false);
    }
  });

  it('publishes stop/status/compact to every surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'web'] as const) {
      for (const n of ['stop', 'status', 'compact']) {
        expect(commandsFor(surface, true).some((c) => c.name === n), `${surface} ${n}`).toBe(true);
      }
    }
  });

  it('publishes /fast from the same catalog to every supported chat surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'web'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'fast'), surface).toBe(true);
    }
  });

  it('scopes /reasoning to the CLI (the only surface that wires the reasoning picker)', () => {
    expect(commandsFor('cli', true).some((c) => c.name === 'reasoning')).toBe(true);
    expect(commandsFor('web', true).some((c) => c.name === 'reasoning')).toBe(false);
    expect(commandsFor('discord', true).some((c) => c.name === 'reasoning')).toBe(false);
  });

  it('scopes local work modes to the CLI surface', () => {
    for (const n of ['plan', 'build', 'yolo']) {
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

  describe('buildPromptTemplates', () => {
    it('maps plugin prompt commands onto PI PromptTemplate[] with synthetic in-memory sources', () => {
      const [tpl] = buildPromptTemplates([{ name: 'deploy', description: 'Ship it', prompt: 'Deploy to $1: $ARGUMENTS' }]);
      // content is copied verbatim — PI (not us) substitutes the placeholders on send.
      expect(tpl).toMatchObject({ name: 'deploy', description: 'Ship it', content: 'Deploy to $1: $ARGUMENTS' });
      expect(tpl.filePath).toBe('db://prompts/deploy'); // synthetic, never read from disk
      expect(tpl.sourceInfo.path).toBe('db://prompts/deploy');
    });
  });

  describe('isPromptCommand', () => {
    const session = { promptTemplates: [{ name: 'deploy' }, { name: 'review' }] };
    it('recognizes a known template slash so the daemon lets PI expand it raw', () => {
      expect(isPromptCommand('/deploy prod now', session)).toBe(true);
      expect(isPromptCommand('/review', session)).toBe(true);
    });
    it('treats an unknown slash or plain text as a normal turn (keeps its context)', () => {
      expect(isPromptCommand('/unknown x', session)).toBe(false);
      expect(isPromptCommand('/etc/passwd is a file', session)).toBe(false);
      expect(isPromptCommand('deploy without a slash', session)).toBe(false);
    });
  });

  it('gates /lsp behind adminOnly (daemon-wide toggle)', () => {
    const lsp = findCommand('lsp')!;
    expect(lsp.adminOnly).toBe(true);
    expect(commandsFor('cli', false).some((c) => c.name === 'lsp')).toBe(false);
    expect(commandsFor('cli', true).some((c) => c.name === 'lsp')).toBe(true);
  });

  it('gates /tdd behind adminOnly and scopes it to the CLI (daemon-wide config toggle)', () => {
    const tdd = findCommand('tdd')!;
    expect(tdd.adminOnly).toBe(true);
    expect(tdd.kind).toBe('action');
    expect(commandsFor('cli', true).some((c) => c.name === 'tdd')).toBe(true);
    expect(commandsFor('cli', false).some((c) => c.name === 'tdd')).toBe(false);
    expect(commandsFor('web', true).some((c) => c.name === 'tdd')).toBe(false);
    expect(commandsFor('discord', true).some((c) => c.name === 'tdd')).toBe(false);
  });
});
