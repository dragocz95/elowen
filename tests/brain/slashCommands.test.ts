import { describe, it, expect } from 'vitest';
import { controlCommandsFrom, runControlCommand } from '../../packages/plugin-shared/chatCommands.mjs';
import { SLASH_COMMANDS, commandsFor, commandsWithPlugins, buildPromptTemplates, isPromptCommand, isReservedCommandName, findCommand } from '../../src/brain/slashCommands.js';
import { SERVER_COMMANDS } from '../../src/api/routes/brainChat.js';
import { PLATFORM_SURFACES } from '../../src/shared/platformIdentity.js';

describe('slash command registry', () => {
  it('exposes the core commands', () => {
    for (const n of ['new', 'stop', 'stats', 'compact', 'plan', 'build', 'model', 'fast', 'reasoning', 'rename', 'restart', 'help']) {
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

  it('publishes one server-owned /goal definition to CLI and Web only', () => {
    for (const surface of ['cli', 'web'] as const) {
      expect(commandsFor(surface, true).find((command) => command.name === 'goal')).toMatchObject({
        kind: 'action', execution: 'session-control', argument: { kind: 'text' },
      });
    }
    for (const surface of PLATFORM_SURFACES) {
      expect(commandsFor(surface, true).some((command) => command.name === 'goal'), surface).toBe(false);
    }
  });

  it('publishes stop/compact to every surface', () => {
    for (const surface of ['cli', 'discord', 'whatsapp', 'web'] as const) {
      for (const n of ['stop', 'compact']) {
        expect(commandsFor(surface, true).some((c) => c.name === n), `${surface} ${n}`).toBe(true);
      }
    }
  });

  /** Session info is ONE command on every surface. It used to be two — `/stats` on the CLI and the web
   *  dock, `/status` published to the chat platforms only, because an adapter cannot draw the overlay and
   *  a channel would otherwise have had no session info at all. Two names for one question is the exact
   *  duplication this catalog exists to prevent, so the platform-only name is gone. How the answer is
   *  DRAWN stays per-surface (overlay vs one-line reply); that is renderer capability, not a second name.
   *  This asserts the split cannot come back on ANY surface, not just the four platforms it lived on. */
  it('publishes session info as one command everywhere, under one name', () => {
    for (const surface of ['cli', 'web', ...PLATFORM_SURFACES] as const) {
      expect(commandsFor(surface, true).some((c) => c.name === 'stats'), surface).toBe(true);
      expect(commandsFor(surface, true).some((c) => c.name === 'status'), surface).toBe(false);
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

    it('drops a plugin command that collides with an adapter-owned reserved name (voice/display)', () => {
      // voice/display are declared in SLASH_COMMANDS (`execution: 'adapter-state'`) but published to no
      // surface — the declaration is what reserves the name. A plugin macro of that name would break
      // Discord's bulk slash registration, so it must never reach a surface menu.
      const merged = commandsWithPlugins('discord', true, [
        { name: 'voice', description: 'x', prompt: 'y' },
        { name: 'display', description: 'x', prompt: 'y' },
        { name: 'deploy', description: 'x', prompt: 'y' },
      ], LOADED);
      expect(merged.some((c) => c.name === 'voice')).toBe(false);
      expect(merged.some((c) => c.name === 'display')).toBe(false);
      expect(merged.some((c) => c.name === 'deploy')).toBe(true); // an ordinary plugin command still passes
    });

    /** A plugin may also declare a command a SURFACE draws itself. The plugin owns the declaration (so
     *  disabling it removes the entry from every menu through this same merge), the surface owns the
     *  renderer — a plugin can ship neither a TUI overlay nor a web dock modal. It therefore publishes as
     *  a surface-local picker with no prompt: there is no model turn behind it. */
    it('publishes a plugin picker command as a surface-local picker with no prompt', () => {
      const picker = [{ name: 'sandbox', description: 'Pick a workspace', kind: 'picker' as const, plugin: 'sbx' }];
      const merged = commandsWithPlugins('cli', true, picker, LOADED).find((c) => c.name === 'sandbox');
      expect(merged).toMatchObject({ kind: 'picker', execution: 'surface-local', plugin: 'sbx' });
      expect(merged?.prompt).toBeUndefined();
    });

    it('keeps a plugin picker from shadowing a built-in or an adapter-owned name', () => {
      // The built-in stays, exactly once, and keeps its own kind — the picker never joins it.
      const withHelp = commandsWithPlugins('cli', true, [{ name: 'help', description: 'x', kind: 'picker' as const }], LOADED);
      expect(withHelp.filter((c) => c.name === 'help')).toHaveLength(1);
      expect(withHelp.find((c) => c.name === 'help')?.kind).toBe('info');
      // An adapter-owned name is reserved but published to no surface, so the picker must vanish entirely.
      const withVoice = commandsWithPlugins('discord', true, [{ name: 'voice', description: 'x', kind: 'picker' as const }], LOADED);
      expect(withVoice.some((c) => c.name === 'voice')).toBe(false);
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

    /** The spawner feeds this EVERY registered plugin command, so the kind filter has to live here: a
     *  picker has no prompt, and letting one through would mint a PromptTemplate with undefined content
     *  that PI would then expand as an empty turn. */
    it('excludes plugin picker commands while keeping the prompt macros', () => {
      const templates = buildPromptTemplates([
        { name: 'deploy', description: 'Ship it', kind: 'prompt', prompt: 'Deploy to $1' },
        { name: 'sandbox', description: 'Pick a workspace', kind: 'picker' },
        { name: 'legacy', description: 'No kind declared', prompt: 'Still a macro' },
      ]);
      expect(templates.map((t) => t.name)).toEqual(['deploy', 'legacy']);
      expect(templates.every((t) => typeof t.content === 'string' && t.content.length > 0)).toBe(true);
    });

    it('skips a command with no usable prompt instead of minting an empty template', () => {
      expect(buildPromptTemplates([{ name: 'broken', description: 'x' }])).toEqual([]);
      expect(buildPromptTemplates([{ name: 'broken', description: 'x', prompt: '' }])).toEqual([]);
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

  /** `execution` says WHICH MECHANISM runs a command; `kind` says how a surface renders it. Together they
   *  are the whole answer to "who runs this", and every consumer now dispatches on them, so these tests
   *  guard the CONSEQUENCES of the classification rather than restating it. */
  describe('execution contract', () => {
    const PLATFORMS = ['discord', 'whatsapp', 'telegram', 'msteams'] as const;
    const SURFACES = ['cli', 'web', ...PLATFORMS] as const;

    /** `commandsFor` is a filter, and the property a filter can silently lose is ORDER — the menu each
     *  surface draws is this list, top to bottom. Asserted as a relative-index invariant against the
     *  catalog rather than against a frozen roster: a table of every published name per surface was a
     *  second copy of the catalog, kept in step by hand, and every per-surface fact it encoded is pinned
     *  deliberately by the tests above (`/clear`, `/rename`, the CLI pickers, `/stats` vs `/status`,
     *  `/fast`, the work modes, `/yolo`, `/lsp`, `/context`). What it alone covered is here. */
    it('keeps every surface menu in catalog declaration order', () => {
      const order = new Map(SLASH_COMMANDS.map((c, i) => [c, i]));
      for (const surface of SURFACES) {
        const positions = commandsFor(surface, true).map((c) => order.get(c)!);
        expect(positions, surface).toEqual([...positions].sort((a, b) => a - b));
        expect(positions.length, surface).toBeGreaterThan(0);
      }
    });

    /** The admin projection is a strict subset, and the only thing withheld is what the catalog marked
     *  `adminOnly` — a filter that dropped anything else would still look like "fewer commands". */
    it('withholds exactly the admin-only commands from a non-operator', () => {
      for (const surface of SURFACES) {
        const asAdmin = commandsFor(surface, true).map((c) => c.name);
        const asUser = commandsFor(surface, false).map((c) => c.name);
        const withheld = commandsFor(surface, true).filter((c) => c.adminOnly).map((c) => c.name);
        expect(asUser, surface).toEqual(asAdmin.filter((n) => !withheld.includes(n)));
        expect(withheld.length, surface).toBeGreaterThan(0);
      }
    });

    it('appends plugin prompt macros after every built-in, on every surface', () => {
      const macro = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy $1' }];
      const loaded = new Set(['skills', 'mcp', 'lsp', 'statusline', 'todo']);
      for (const surface of SURFACES) {
        for (const isAdmin of [false, true]) {
          expect(commandsWithPlugins(surface, isAdmin, macro, loaded).map((c) => c.name), `${surface} admin=${isAdmin}`)
            .toEqual([...commandsFor(surface, isAdmin).map((c) => c.name), 'deploy']);
        }
      }
    });

    /** A `session-control` PICKER is the one classification no generic dispatcher can serve: too stateful
     *  for `POST /brain/command` (which takes actions only) and un-drawable by the adapters' shared control
     *  core (`controlCommandsFrom` excludes pickers), so it needs a dedicated endpoint and a chooser per
     *  surface. `/context` is the only command that has ever paid for that, and this list is small and
     *  deliberate for exactly that reason: adding a second one is a real design decision — three surfaces'
     *  worth of UI and a new PlatformControlApi pair — not a catalog edit. The two sets that used to
     *  restate the whole classification here are gone: the `action` half is pinned against the route's own
     *  dispatch table below, the daemon-run non-pickers against what `runControlCommand` really handles,
     *  and `adapter-state` against the published projection. */
    it('leaves /context the only command needing its own dispatch path', () => {
      const needsOwnPath = SLASH_COMMANDS
        .filter((c) => c.execution === 'session-control' && c.kind === 'picker')
        .map((c) => c.name);
      expect([...new Set(needsOwnPath)]).toEqual(['context']);
    });

    it('marks a plugin prompt macro, and only a plugin prompt macro, as plugin-executed', () => {
      const macro = [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy $1' }];
      const loaded = new Set(['skills', 'mcp', 'lsp', 'statusline', 'todo']);
      for (const surface of SURFACES) {
        for (const c of commandsWithPlugins(surface, true, macro, loaded)) {
          expect(c.execution === 'plugin-prompt', `${surface} /${c.name}`).toBe(c.kind === 'prompt');
        }
      }
    });

    /** THE drift lock — now against the thing that runs, not against a second name list. The adapters no
     *  longer keep one: each derives its control set straight from this catalog with
     *  `controlCommandsFrom`, so "the two lists agree" has become tautological and the literal it compared
     *  against is gone.
     *
     *  What can still part ways is the catalog and the shared core's actual switch. `/status` already
     *  proved it: dropped from the CLI and the web dock while `runControlCommand` kept executing it on the
     *  platforms. So assert the half that still has two sides — every control command this catalog
     *  publishes to a platform must be one the core really handles.
     *
     *  Behaviourally, because that switch is the ONLY statement of what the core owns: an unowned name
     *  falls to `default` and returns false without touching the binding, which is exactly the "adapter
     *  cannot run it" branch the adapters fall through on. */
    it('publishes no platform control command the shared core cannot run', async () => {
      // Every message key answers as a callable, so the value-shaped ones (`msg.stopped`) and the
      // function-shaped ones (`msg.fastSet(false)`) are both satisfied without restating the message set.
      const stub = () => ({
        msg: new Proxy({}, { get: () => () => '' }),
        reply: () => {}, isAdmin: () => true, stateId: 'X', ref: 'ref',
        state: { get: () => ({}), patch: () => {} },
        ctl: { status: () => null, abort: () => {}, compact: async () => null, restart: async () => {}, setFast: () => null },
        activeModel: async () => null,
      });
      for (const surface of PLATFORMS) {
        // Pickers are excluded: /context is also `session-control`, but its listing/binding runs through
        // dedicated PlatformControlApi methods and its own per-surface chooser, not the control core.
        const control = controlCommandsFrom(commandsFor(surface, true)) as Set<string>;
        expect(control.size, surface).toBeGreaterThan(0);
        for (const name of control) {
          expect(await runControlCommand(name, stub()), `${surface} /${name}`).toBe(true);
        }
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
     *  that is also `session-control`. Both halves of that sentence are read from the code that lives it —
     *  the catalog on one side, the route's own SERVER_COMMANDS table on the other — because a literal
     *  list of the six names here would be a THIRD copy, and the copy that stays green while the route
     *  loses a command. Dropping a handler, or declaring a server-run command without one, fails this. */
    it('keeps the server-dispatchable set equal to the dispatch table of POST /brain/command', () => {
      const dispatchable = SLASH_COMMANDS
        .filter((c) => c.kind === 'action' && c.execution === 'session-control')
        .map((c) => c.name);
      expect(dispatchable.sort()).toEqual(Object.keys(SERVER_COMMANDS).sort());
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
      expect(findCommand('fast')?.argument).toEqual({ kind: 'enum', values: ['on', 'off', 'status'] });
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
