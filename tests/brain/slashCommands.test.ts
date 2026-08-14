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
    for (const n of ['sessions', 'resume', 'delete', 'quit']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
      expect(commandsFor('web', true).some((c) => c.name === n), `web ${n}`).toBe(false);
    }
  });

  it('publishes /rename to the web dock (it has its own rename dialog) but not to the chat platforms', () => {
    expect(commandsFor('cli', true).some((c) => c.name === 'rename')).toBe(true);
    expect(commandsFor('web', true).some((c) => c.name === 'rename')).toBe(true);
    expect(commandsFor('discord', true).some((c) => c.name === 'rename')).toBe(false);
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

  it('publishes /reasoning to the CLI and every chat platform that wires the picker (not web)', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'telegram'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'reasoning'), surface).toBe(true);
    }
    expect(commandsFor('web', true).some((c) => c.name === 'reasoning')).toBe(false);
  });

  it('publishes the work modes to the CLI and the web dock (both stamp the mode per send)', () => {
    for (const n of ['plan', 'build', 'workflow']) {
      expect(commandsFor('cli', true).some((c) => c.name === n), `cli ${n}`).toBe(true);
      expect(commandsFor('web', true).find((c) => c.name === n)?.kind, `web ${n}`).toBe('mode');
      expect(commandsFor('discord', true).some((c) => c.name === n), `discord ${n}`).toBe(false);
    }
  });

  it('keeps /yolo CLI-local (the TUI calls POST /brain/yolo itself)', () => {
    expect(commandsFor('cli', true).some((c) => c.name === 'yolo')).toBe(true);
    expect(commandsFor('web', true).some((c) => c.name === 'yolo')).toBe(false);
    expect(commandsFor('discord', true).some((c) => c.name === 'yolo')).toBe(false);
  });

  it('every command has a non-empty English description', () => {
    for (const c of SLASH_COMMANDS) expect(c.description.trim().length, c.name).toBeGreaterThan(0);
  });

  // `context` names two unrelated commands — the CLI's context breakdown and the platforms' channel
  // re-key — so the invariant that matters is per surface: a menu carrying the same name twice would make
  // a chat platform's bulk slash registration fail and drop every command for the guild.
  it('never shows one surface two commands under the same name', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'telegram', 'msteams', 'web'] as const) {
      const names = commandsFor(surface, true).map((c) => c.name);
      expect(new Set(names).size, surface).toBe(names.length);
    }
  });


  describe('plugin-contributed prompt commands', () => {
    // The plugin-gated built-ins are present in these cases so the merge assertions keep their subject.
    const LOADED = new Set(['skills', 'mcp']);
    const plugin = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy to $1 with notes: $ARGS', plugin: 'ops' }];

    it('merges plugin commands after the built-ins for the surface', () => {
      const cli = commandsWithPlugins('cli', true, plugin, LOADED);
      const deploy = cli.find((c) => c.name === 'deploy');
      expect(deploy).toMatchObject({ kind: 'prompt', prompt: 'Deploy to $1 with notes: $ARGS', plugin: 'ops' });
      // built-ins still present and come first
      expect(cli.findIndex((c) => c.name === 'help')).toBeLessThan(cli.findIndex((c) => c.name === 'deploy'));
    });

    it('never lets a plugin command shadow a built-in', () => {
      const merged = commandsWithPlugins('cli', true, [{ name: 'help', description: 'x', prompt: 'y' }], LOADED);
      expect(merged.filter((c) => c.name === 'help')).toHaveLength(1);
      expect(merged.find((c) => c.name === 'help')?.kind).toBe('info');
      expect(isBuiltinCommand('help')).toBe(true);
      expect(isBuiltinCommand('deploy')).toBe(false);
    });

    it('drops a plugin command that collides with an adapter-local reserved name (voice/display)', () => {
      // voice/display are adapter-local (not in SLASH_COMMANDS) yet reserved: a plugin macro of that name
      // would break Discord's bulk slash registration, so it must never reach a surface menu.
      const merged = commandsWithPlugins('discord', true, [
        { name: 'voice', description: 'x', prompt: 'y' },
        { name: 'display', description: 'x', prompt: 'y' },
        { name: 'deploy', description: 'x', prompt: 'y' },
      ], LOADED);
      expect(merged.some((c) => c.name === 'voice')).toBe(false);
      expect(merged.some((c) => c.name === 'display')).toBe(false);
      expect(merged.some((c) => c.name === 'deploy')).toBe(true); // an ordinary plugin command still passes
    });

    it('respects a plugin command surface restriction', () => {
      const cliOnly = [{ name: 'lint', description: 'x', prompt: 'lint it', surfaces: ['cli' as const] }];
      expect(commandsWithPlugins('cli', true, cliOnly, LOADED).some((c) => c.name === 'lint')).toBe(true);
      expect(commandsWithPlugins('web', true, cliOnly, LOADED).some((c) => c.name === 'lint')).toBe(false);
    });
  });

  // A built-in whose payload comes entirely from a plugin (`/skills` renders that plugin's routes,
  // `/mcp` that one's) is worse than useless when the plugin is not running: the surface offers a picker
  // that can only report an error. Since those plugins can live in the marketplace rather than in the
  // package, "not running" is an ordinary healthy state, not a broken install.
  describe('built-ins gated on a plugin', () => {
    it('hides a gated built-in when its plugin is not loaded, and keeps the ungated ones', () => {
      const none = commandsWithPlugins('cli', true, [], new Set());
      expect(none.some((c) => c.name === 'skills')).toBe(false);
      expect(none.some((c) => c.name === 'mcp')).toBe(false);
      expect(none.some((c) => c.name === 'compact')).toBe(true);
    });

    it('shows exactly the gated built-ins whose plugin is loaded', () => {
      const onlySkills = commandsWithPlugins('cli', true, [], new Set(['skills']));
      expect(onlySkills.some((c) => c.name === 'skills')).toBe(true);
      expect(onlySkills.some((c) => c.name === 'mcp')).toBe(false);
    });

    it('gates every surface the command is offered on, not just the CLI', () => {
      // /skills is a CLI+web command; the web dock builds its menu from the same endpoint.
      expect(commandsWithPlugins('web', true, [], new Set()).some((c) => c.name === 'skills')).toBe(false);
      expect(commandsWithPlugins('web', true, [], new Set(['skills'])).some((c) => c.name === 'skills')).toBe(true);
    });

    it('never gates a command the server itself dispatches', () => {
      // The gate lives in the MENU. `POST /brain/command` resolves an `action` through findCommand, which
      // does not consult it — so an `action` that needed a plugin would still be executed by anyone who
      // sent its name, gate or no gate. Keeping gated commands client-dispatched (picker/info) is what
      // makes hiding them sufficient.
      const gated = SLASH_COMMANDS.filter((c) => c.requiresPlugin);
      expect(gated.length).toBeGreaterThan(0);
      for (const c of gated) expect(c.kind).not.toBe('action');
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

  // `context` is one name over two unrelated commands, split strictly by surface: the channel re-key on
  // the platforms (there is no channel to re-key from a terminal) and the context breakdown in the CLI.
  it('publishes the channel re-key /context to every platform surface and the breakdown to the CLI', () => {
    for (const surface of ['discord', 'whatsapp', 'telegram', 'web'] as const) {
      expect(commandsFor(surface, true).find((c) => c.name === 'context')?.kind, `${surface} context`).toBe('picker');
    }
    // The CLI's own /context is the read-only breakdown, for operators and non-operators alike.
    expect(commandsFor('cli', true).find((c) => c.name === 'context')?.kind).toBe('info');
    expect(commandsFor('cli', false).find((c) => c.name === 'context')?.kind).toBe('info');
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
