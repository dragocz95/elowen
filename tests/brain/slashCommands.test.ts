import { describe, it, expect } from 'vitest';
import { CONTROL_COMMANDS } from '../../packages/plugin-shared/chatCommands.mjs';
import { SLASH_COMMANDS, commandsFor, commandsWithPlugins, buildPromptTemplates, isPromptCommand, isReservedCommandName, findCommand } from '../../src/brain/slashCommands.js';
import type { SlashSurface } from '../../src/brain/slashCommands.js';
import { PLATFORM_SURFACES } from '../../src/shared/platformIdentity.js';

describe('slash command registry', () => {
  it('exposes the core commands', () => {
    for (const n of ['new', 'stop', 'status', 'compact', 'plan', 'build', 'model', 'fast', 'reasoning', 'rename', 'restart', 'help']) {
      expect(findCommand(n), n).toBeDefined();
    }
  });

  /** `/clear` empties the caller's OWN conversation, which only the CLI and the web dock address; a chat
   *  platform's channel session is not one, so publishing it there would offer a command whose dispatch
   *  can only answer "unknown session". It must stay an `action`: any other kind is client-dispatched,
   *  and a `prompt` would hand the slash to the model as text. */
  it('publishes /clear as a server-dispatched action, on the CLI and the web dock only', () => {
    expect(findCommand('clear')).toMatchObject({ kind: 'action' });
    expect(commandsFor('cli', false).some((c) => c.name === 'clear')).toBe(true);
    expect(commandsFor('web', false).some((c) => c.name === 'clear')).toBe(true);
    for (const surface of ['discord', 'whatsapp', 'telegram', 'msteams'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'clear'), surface).toBe(false);
    }
    // Reserved like every other built-in: a plugin macro can never shadow a destructive command.
    expect(isReservedCommandName('clear')).toBe(true);
    expect(commandsWithPlugins('cli', true, [{ name: 'clear', description: 'x', prompt: 'wipe it' }], new Set())
      .filter((c) => c.name === 'clear')).toHaveLength(1);
    expect(commandsWithPlugins('cli', true, [{ name: 'clear', description: 'x', prompt: 'wipe it' }], new Set())
      .find((c) => c.name === 'clear')?.kind).toBe('action');
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

  it('publishes stop/compact to every surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'web'] as const) {
      for (const n of ['stop', 'compact']) {
        expect(commandsFor(surface, true).some((c) => c.name === n), `${surface} ${n}`).toBe(true);
      }
    }
  });

  /** `/stats` replaced `/status` on the CLI and the web dock (it is a strict superset there — the same
   *  session rows plus per-model totals and the context breakdown). The chat platforms keep `/status`:
   *  their one-line answer comes from the adapters' shared control core (CONTROL_COMMANDS), which cannot
   *  draw the overlay, so retiring it there would leave a channel with no session info at all. */
  it('splits session info: /stats on cli+web, /status on the chat platforms only', () => {
    for (const surface of ['cli', 'web'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'stats'), surface).toBe(true);
      expect(commandsFor(surface, true).some((c) => c.name === 'status'), surface).toBe(false);
    }
    for (const surface of ['discord', 'whatsapp', 'telegram', 'msteams'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'status'), surface).toBe(true);
      expect(commandsFor(surface, true).some((c) => c.name === 'stats'), surface).toBe(false);
    }
  });

  it('publishes /fast from the same catalog to every supported chat surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'web'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'fast'), surface).toBe(true);
    }
  });

  // Every surface now wires its own reasoning picker, the web dock included (ReasoningModal).
  it('publishes /reasoning to every surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'telegram', 'msteams', 'web'] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'reasoning'), surface).toBe(true);
    }
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
    const LOADED = new Set(['skills', 'mcp', 'todo']);
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
      expect(isReservedCommandName('help')).toBe(true);
      expect(isReservedCommandName('deploy')).toBe(false);
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
      expect(none.some((c) => c.name === 'tasks')).toBe(false);
      expect(none.some((c) => c.name === 'compact')).toBe(true);
    });

    it('shows exactly the gated built-ins whose plugin is loaded', () => {
      const onlySkills = commandsWithPlugins('cli', true, [], new Set(['skills']));
      expect(onlySkills.some((c) => c.name === 'skills')).toBe(true);
      expect(onlySkills.some((c) => c.name === 'mcp')).toBe(false);
      expect(onlySkills.some((c) => c.name === 'tasks')).toBe(false);
    });

    it('gates every surface the command is offered on, not just the CLI', () => {
      // /skills is a CLI+web command; the web dock builds its menu from the same endpoint.
      expect(commandsWithPlugins('web', true, [], new Set()).some((c) => c.name === 'skills')).toBe(false);
      expect(commandsWithPlugins('web', true, [], new Set(['skills'])).some((c) => c.name === 'skills')).toBe(true);
      expect(commandsWithPlugins('web', true, [], new Set(['todo'])).some((c) => c.name === 'tasks')).toBe(true);
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
    for (const surface of ['discord', 'whatsapp', 'telegram', 'msteams'] as const) {
      expect(commandsFor(surface, true).find((c) => c.name === 'context')?.kind, `${surface} context`).toBe('picker');
    }
    // The CLI's own /context is the read-only breakdown, for operators and non-operators alike.
    expect(commandsFor('cli', true).find((c) => c.name === 'context')?.kind).toBe('info');
    expect(commandsFor('cli', false).find((c) => c.name === 'context')?.kind).toBe('info');
    // Neither `context` reaches the web dock: there is no channel to re-key, and the breakdown lives in
    // the /stats modal's own Context section. Publishing it left a menu entry with no dispatch behind it.
    expect(commandsFor('web', true).some((c) => c.name === 'context')).toBe(false);
  });

  it('gates /lsp behind adminOnly (daemon-wide toggle) and its own plugin', () => {
    const lsp = findCommand('lsp')!;
    expect(lsp.adminOnly).toBe(true);
    expect(lsp.requiresPlugin).toBe('lsp');
    expect(commandsFor('cli', false).some((c) => c.name === 'lsp')).toBe(false);
    expect(commandsFor('cli', true).some((c) => c.name === 'lsp')).toBe(true);
  });

  /** The modal drives a plugin's REST surface, so without that plugin the entry could only open onto a
   *  503. Both are pickers, which is what makes hiding them a sufficient gate (see the test above). */
  it('hides /lsp and /statusline when their plugin is not loaded', () => {
    for (const name of ['lsp', 'statusline']) {
      expect(commandsWithPlugins('cli', true, [], new Set()).some((c) => c.name === name)).toBe(false);
      expect(commandsWithPlugins('cli', true, [], new Set([name])).some((c) => c.name === name)).toBe(true);
    }
  });

  /** `/tdd` was a second switch for `plugins.config.agents.tddMode`, which the agents plugin already
   *  exposes as a labelled config field — the CLI copy could only ever report "needs the agents plugin"
   *  on an install without it. The flag itself and its worker directive are untouched. */
  it('no longer ships a /tdd command', () => {
    expect(findCommand('tdd')).toBeUndefined();
    expect(commandsFor('cli', true).some((c) => c.name === 'tdd')).toBe(false);
  });

  /** `execution` says WHICH MECHANISM runs a command; `kind` says how a surface renders it. The field is
   *  published but nothing dispatches on it yet, so these tests guard two things: that the catalog states
   *  the truth about today's behaviour, and that adding the field moved nothing. */
  describe('execution contract', () => {
    const PLATFORMS = ['discord', 'whatsapp', 'telegram', 'msteams'] as const;
    const SURFACES = ['cli', 'web', ...PLATFORMS] as const;
    /** Identity of a published entry as it existed BEFORE `execution` — name, rendering and both gates,
     *  in menu order. */
    const shape = (c: { name: string; kind: string; adminOnly?: boolean; requiresPlugin?: string }): string =>
      `${c.name}:${c.kind}${c.adminOnly ? '!' : ''}${c.requiresPlugin ? `@${c.requiresPlugin}` : ''}`;

    /** Frozen from the catalog as it stood before this field existed (generated from `HEAD`, surface by
     *  surface). A phase that is supposed to be purely additive must leave every one of these untouched;
     *  the later phases that DO move commands have to change this table deliberately. */
    const PUBLISHED_SHAPE: Record<SlashSurface, string[]> = {
      cli: ['new:action', 'clear:action', 'stop:action', 'stats:info', 'context:info', 'mcp:picker@mcp', 'skills:picker@skills', 'tasks:picker@todo', 'goal:action', 'subgoal:action', 'tools:picker', 'compact:action', 'plan:mode', 'build:mode', 'workflow:mode', 'yolo:action', 'model:picker', 'fast:action', 'reasoning:picker', 'theme:picker', 'maskot:action', 'keybinds:info', 'statusline:picker@statusline', 'cd:action', 'paste:action', 'editor:picker', 'export:action', 'lsp:picker!@lsp', 'restart:action!', 'help:info', 'sessions:picker', 'resume:picker', 'rename:picker', 'delete:picker', 'quit:action'],
      web: ['new:action', 'clear:action', 'stop:action', 'stats:info', 'skills:picker@skills', 'tasks:picker@todo', 'compact:action', 'plan:mode', 'build:mode', 'workflow:mode', 'model:picker', 'fast:action', 'reasoning:picker', 'restart:action!', 'help:info', 'rename:picker'],
      discord: ['new:action', 'stop:action', 'status:info', 'compact:action', 'model:picker', 'context:picker', 'fast:action', 'reasoning:picker', 'restart:action!', 'help:info'],
      whatsapp: ['new:action', 'stop:action', 'status:info', 'compact:action', 'model:picker', 'context:picker', 'fast:action', 'reasoning:picker', 'restart:action!', 'help:info'],
      telegram: ['new:action', 'stop:action', 'status:info', 'compact:action', 'model:picker', 'context:picker', 'fast:action', 'reasoning:picker', 'restart:action!', 'help:info'],
      msteams: ['new:action', 'stop:action', 'status:info', 'compact:action', 'model:picker', 'context:picker', 'fast:action', 'reasoning:picker', 'restart:action!', 'help:info'],
    };

    it('leaves every surface roster, order, kind and gate unchanged for both admin projections', () => {
      const macro = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy $1' }];
      const loaded = new Set(['skills', 'mcp', 'lsp', 'statusline', 'todo']);
      for (const surface of SURFACES) {
        for (const isAdmin of [false, true]) {
          const expected = PUBLISHED_SHAPE[surface].filter((entry) => isAdmin || !entry.includes('!'));
          expect(commandsFor(surface, isAdmin).map(shape), `${surface} admin=${isAdmin}`).toEqual(expected);
          expect(commandsWithPlugins(surface, isAdmin, macro, loaded).map(shape), `${surface}+plugins admin=${isAdmin}`)
            .toEqual([...expected, 'deploy:prompt']);
        }
      }
    });

    it('states the exact execution mechanism for every built-in and plugin prompt', () => {
      const identity = (c: { name: string; kind: string; surfaces?: readonly string[] }) =>
        `${c.name}:${c.kind}:${c.surfaces?.join(',') ?? '*'}`;
      const sessionControls = new Set([
        'new:action:*',
        'clear:action:cli,web',
        'stop:action:*',
        'status:info:discord,msteams,telegram,whatsapp',
        'compact:action:*',
        'context:picker:discord,msteams,telegram,whatsapp',
        'fast:action:cli,web,discord,msteams,telegram,whatsapp',
        'restart:action:*',
      ]);
      // The adapter-owned pair: dispatched entirely by a chat adapter's own per-channel state, declared
      // here only so the catalog is the one declaration site (and the one reserved-name check).
      const adapterState = new Set([
        'voice:action:discord,msteams,telegram,whatsapp',
        'display:action:discord,msteams,telegram,whatsapp',
      ]);
      for (const c of SLASH_COMMANDS) {
        const expected = sessionControls.has(identity(c)) ? 'session-control'
          : adapterState.has(identity(c)) ? 'adapter-state'
            : 'surface-local';
        expect(c.execution, `/${identity(c)}`).toBe(expected);
      }
      const macro = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy $1' }];
      const loaded = new Set(['skills', 'mcp', 'lsp', 'statusline', 'todo']);
      for (const surface of SURFACES) {
        const published = commandsWithPlugins(surface, true, macro, loaded);
        for (const c of published) {
          expect(c.execution === 'plugin-prompt', `${surface} /${c.name}`).toBe(c.kind === 'prompt');
        }
      }
    });

    /** THE drift lock between the two registries. The catalog is the source of truth for WHICH commands a
     *  platform gets; `CONTROL_COMMANDS` (packages/plugin-shared) is the independent set the adapters
     *  actually execute. `/status` proved they can part ways: it was dropped from the CLI and the web dock
     *  while `runControlCommand` kept executing it on the platforms. Declaring `execution` only helps if
     *  the two sets are held equal, so hold them here — the catalog's platform control commands must be
     *  exactly the ones that shared core owns.
     *
     *  The rule below (`session-control` and not a `picker`) is the one an adapter can now evaluate for
     *  itself: `ctx.chatCommands(surface)` carries `execution`, so the hand-written `CONTROL_COMMANDS`
     *  literal becomes a derived value on the adapter side and this equality stops needing to be
     *  maintained at all. Until that ships through npm, it is asserted. */
    it('declares exactly the control set the adapters shared core executes', () => {
      for (const surface of PLATFORMS) {
        // Pickers are excluded: /context is also `session-control`, but its listing/binding runs through
        // dedicated PlatformControlApi methods and its own per-surface chooser, not the control core.
        const declared = commandsFor(surface, true)
          .filter((c) => c.execution === 'session-control' && c.kind !== 'picker')
          .map((c) => c.name);
        expect(declared.sort(), surface).toEqual([...CONTROL_COMMANDS].sort());
      }
    });

    /** The adapter-owned commands are DECLARED in the catalog (so this file is the one place a command is
     *  declared, and catalog membership is the only reserved-name check) but must stay OUT of every
     *  published projection: each adapter still appends them to its own registration payload, and the same
     *  name twice in one Discord bulk registration is a 400 that drops every slash command for the guild.
     *  Both halves are load-bearing, so both are asserted here. */
    it('declares the adapter-owned commands but publishes them to no surface', () => {
      const owned = SLASH_COMMANDS.filter((c) => c.execution === 'adapter-state').map((c) => c.name);
      expect(owned.sort()).toEqual(['display', 'voice']);
      for (const name of owned) {
        expect(findCommand(name), name).toBeDefined();
        expect(isReservedCommandName(name), name).toBe(true);
        // The reservation spans every platform — including one whose adapter does not dispatch the
        // command today, so a plugin macro can never claim the name ahead of an adapter that adds it.
        expect(findCommand(name)?.surfaces, name).toEqual([...PLATFORM_SURFACES]);
        for (const surface of SURFACES) {
          expect(commandsFor(surface, true).some((c) => c.name === name), `${surface} /${name}`).toBe(false);
          // …and a plugin macro of that name is still refused on every surface, gate or no gate.
          expect(
            commandsWithPlugins(surface, true, [{ name, description: 'x', prompt: 'y' }], new Set()).some((c) => c.name === name),
            `${surface} macro /${name}`,
          ).toBe(false);
        }
      }
    });

    /** `execution` is what `POST /brain/command` dispatches on (src/api/routes/brainChat.ts): an `action`
     *  that is also `session-control`. Its switch must therefore have a case for exactly these names —
     *  adding a seventh without one would answer 400 for a command the catalog advertises as server-run. */
    it('keeps the server-dispatchable set equal to the switch in POST /brain/command', () => {
      const dispatchable = SLASH_COMMANDS
        .filter((c) => c.kind === 'action' && c.execution === 'session-control')
        .map((c) => c.name);
      expect(dispatchable.sort()).toEqual(['clear', 'compact', 'fast', 'new', 'restart', 'stop']);
    });

    /** The duplicated `context` name stays two commands, and `execution` is now the field that PROVES it:
     *  the CLI's breakdown is a local overlay, the platforms' re-key is a daemon operation on the channel
     *  session. Since they differ in both `kind` and `execution`, they cannot be folded into one entry —
     *  and `findCommand` remains first-match, so it still cannot answer how `/context` runs. */
    it('resolves the twice-carried `context` name to one execution per surface', () => {
      const entries = SLASH_COMMANDS.filter((c) => c.name === 'context');
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((c) => c.execution)).size).toBe(2);
      expect(commandsFor('cli', true).find((c) => c.name === 'context')?.execution).toBe('surface-local');
      for (const surface of PLATFORMS) {
        expect(commandsFor(surface, true).find((c) => c.name === 'context')?.execution, surface).toBe('session-control');
      }
    });

    it('declares arguments only where every surface accepts the same values', () => {
      expect(findCommand('fast')?.argument).toEqual({ kind: 'enum', values: ['on', 'off'] });
      // Platform compact parses text but runControlCommand currently drops it before ctl.compact(ref).
      expect(findCommand('compact')?.argument).toBeUndefined();
      // `show` is CLI/web-only; platform /reasoning opens its picker and ignores the text argument.
      expect(findCommand('reasoning')?.argument).toBeUndefined();
      // Transport option schemas (Discord's option definitions) stay in the adapters; a declared enum that
      // enumerates nothing would be one of those leaking in as an empty shell.
      for (const c of SLASH_COMMANDS) {
        if (c.argument?.kind === 'enum') expect(c.argument.values.length, c.name).toBeGreaterThan(0);
      }
    });
  });
});
