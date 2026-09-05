import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — plain .mjs plugin module, no types
import { controlCommandsFrom } from '../../packages/plugin-shared/chatCommands.mjs';
import { PluginRegistry } from '../../src/plugins/registry.js';
import type { PluginSkill } from '../../src/plugins/api.js';
import type { EmbeddingConfig } from '../../src/embeddings/embeddingService.js';
import { DEFAULT_BRAIN_LIMITS } from '../../src/store/configStore.js';

const noopLog = { info() {}, warn() {}, error() {} };
const fakeSkill = (name: string) => ({ name, description: 'd', filePath: `/s/${name}.md` } as unknown as PluginSkill);

describe('PluginRegistry', () => {
  it('collects contributions from a register() call', () => {
    const reg = new PluginRegistry();
    const ctx = reg.contextFor('demo', { k: 1 }, noopLog);
    const indicators = () => [{ projectId: 1, label: 'Connected' }] as const;
    ctx.registerSkill(fakeSkill('s'));
    ctx.registerSystemPromptFragment('extra rules');
    ctx.registerHook({ name: 'h', run: () => {} });
    ctx.registerProjectIndicators(indicators);
    expect(reg.skills.map((s) => s.name)).toEqual(['s']);
    expect(reg.promptFragments).toEqual(['extra rules']);
    expect(reg.hooks).toHaveLength(1);
    expect(reg.projectIndicatorProviders).toEqual([{ plugin: 'demo', fn: indicators }]);
    expect(ctx.config).toEqual({ k: 1 });
  });

  it('reserves SkillLoad for the canonical skills plugin', () => {
    const warn = vi.fn();
    const reg = new PluginRegistry();
    reg.contextFor('rogue', {}, { info() {}, warn, error() {} })
      .registerTool({ name: 'SkillLoad', label: 'rogue', description: 'rogue' } as never);
    expect(reg.tools.map((tool) => tool.name)).not.toContain('SkillLoad');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reserved for plugin 'skills'"));

    reg.contextFor('skills', {}, noopLog)
      .registerTool({ name: 'SkillLoad', label: 'canonical', description: 'canonical' } as never);
    expect(reg.toolOwner.get('SkillLoad')).toBe('skills');
  });

  describe('toolsFor (per-account tool sets)', () => {
    const accessUser = (over: Partial<{ is_admin: boolean; granted_plugins: string[] }> = {}) =>
      ({ is_admin: false, granted_plugins: [] as string[], ...over });
    const tool = (name: string, marker: string) => ({ name, label: marker, description: marker } as never);

    it('gives each account instance tools plus only its own, and fails closed without an account', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('mcp', {}, noopLog);
      ctx.registerTool(tool('shared', 'shared'));
      ctx.registerTool(tool('amy', 'amy'), { ownerUserId: 4 });
      ctx.registerTool(tool('bob', 'bob'), { ownerUserId: 5 });

      expect(reg.toolsFor(4, accessUser()).map((t) => t.name)).toEqual(['shared', 'amy']);
      expect(reg.toolsFor(5, accessUser()).map((t) => t.name)).toEqual(['shared', 'bob']);
      expect(reg.toolsFor(null).map((t) => t.name)).toEqual(['shared']);
      expect(reg.toolsFor(undefined).map((t) => t.name)).toEqual(['shared']);
    });

    it('lets an owner-scoped definition override the same instance tool name only for that owner', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('mcp', {}, noopLog);
      ctx.registerTool(tool('ListMcpResources', 'instance'));
      ctx.registerTool(tool('ListMcpResources', 'amy'), { ownerUserId: 4 });

      expect(reg.toolsFor(4, accessUser())).toHaveLength(1);
      expect(reg.toolsFor(4, accessUser())[0]!.label).toBe('amy');
      expect(reg.toolsFor(5, accessUser())[0]!.label).toBe('instance');
      expect(reg.toolsFor(null)[0]!.label).toBe('instance');
    });

    it('carries tool ownership through registry merge', () => {
      const merged = new PluginRegistry();
      const staged = new PluginRegistry();
      staged.contextFor('mcp', {}, noopLog).registerTool(tool('private', 'amy'), { ownerUserId: 4 });
      merged.merge(staged);
      expect(merged.toolsFor(4, accessUser()).map((t) => t.name)).toEqual(['private']);
      expect(merged.toolsFor(5, accessUser())).toEqual([]);
    });
  });

  describe('skillsFor (per-account skill sets)', () => {
    const accessUser = (over: Partial<{ is_admin: boolean; granted_plugins: string[] }> = {}) =>
      ({ is_admin: false, granted_plugins: [] as string[], ...over });

    // The prompt cache is instance-wide: the system prompt of a user with no personal skills must stay
    // BYTE-identical to what it was before per-user skills existed, so the shared prefix keeps hitting.
    it('returns the very same array when nothing is owned by an account or grant-filtered', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('skills', {}, noopLog);
      ctx.registerSkill(fakeSkill('shared'));
      expect(reg.skillsFor(7, accessUser())).toBe(reg.skills);
      expect(reg.skillsFor(null)).toBe(reg.skills);
    });

    it('gives each account the instance-wide skills plus only its own', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('skills', {}, noopLog);
      ctx.registerSkill(fakeSkill('shared'));
      ctx.registerSkill(fakeSkill('amy-only'), { ownerUserId: 4 });
      ctx.registerSkill(fakeSkill('bob-only'), { ownerUserId: 5 });

      expect(reg.skillsFor(4, accessUser()).map((s) => s.name)).toEqual(['shared', 'amy-only']);
      expect(reg.skillsFor(5, accessUser()).map((s) => s.name)).toEqual(['shared', 'bob-only']);
      // A shared channel (no single owner) and an unlinked sender see the instance set only — a set
      // fixed at spawn cannot follow a sender who changes from turn to turn.
      expect(reg.skillsFor(null).map((s) => s.name)).toEqual(['shared']);
      expect(reg.skillsFor(undefined).map((s) => s.name)).toEqual(['shared']);
      // `skills` stays the full catalogue for the surfaces that manage it.
      expect(reg.skills).toHaveLength(3);
    });

    it('returns one name and lets the owner personal definition shadow the instance definition', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('skills', {}, noopLog);
      const shared = fakeSkill('same-name');
      const personal = { ...fakeSkill('same-name'), description: 'personal body' };
      ctx.registerSkill(shared);
      ctx.registerSkill(personal, { ownerUserId: 4 });
      ctx.registerSkill({ ...fakeSkill('same-name'), description: 'later duplicate' });

      expect(reg.skillsFor(4, accessUser())).toEqual([personal]);
      expect(reg.skillsFor(5, accessUser())).toEqual([shared]);
      expect(reg.skillsFor(null)).toEqual([shared]);
    });

    it('pins the canonical base directory when the skill is registered', () => {
      const root = mkdtempSync(join(tmpdir(), 'elowen-skill-root-'));
      try {
        const first = join(root, 'first');
        const second = join(root, 'second');
        const link = join(root, 'current');
        mkdirSync(first);
        mkdirSync(second);
        writeFileSync(join(first, 'SKILL.md'), '# first\n');
        writeFileSync(join(second, 'SKILL.md'), '# second\n');
        symlinkSync(first, link, 'dir');
        const reg = new PluginRegistry();
        const skill = { ...fakeSkill('pinned'), filePath: join(link, 'SKILL.md'), baseDir: link };
        reg.contextFor('skills', {}, noopLog).registerSkill(skill);
        expect(reg.skillCanonicalBaseDir(skill)).toBe(realpathSync(first));

        rmSync(link);
        symlinkSync(second, link, 'dir');
        expect(reg.skillCanonicalBaseDir(skill)).toBe(realpathSync(first));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('shows a grant-gated plugin skill to a user who holds its grant', () => {
      const reg = new PluginRegistry();
      reg.contextFor('cronjob', {}, noopLog).registerSkill(fakeSkill('cron-schedule'));
      reg.setUserGrantable('cronjob', true);

      expect(reg.skillsFor(4, accessUser({ granted_plugins: ['cronjob'] })).map((s) => s.name))
        .toEqual(['cron-schedule']);
    });

    it('hides a grant-gated plugin skill from a non-admin without its grant', () => {
      const reg = new PluginRegistry();
      reg.contextFor('cronjob', {}, noopLog).registerSkill(fakeSkill('cron-schedule'));
      reg.setUserGrantable('cronjob', true);

      expect(reg.skillsFor(4, accessUser()).map((s) => s.name)).toEqual([]);
    });

    it('always shows grant-gated plugin skills to an admin', () => {
      const reg = new PluginRegistry();
      reg.contextFor('cronjob', {}, noopLog).registerSkill(fakeSkill('cron-schedule'));
      reg.setUserGrantable('cronjob', true);

      expect(reg.skillsFor(1, accessUser({ is_admin: true })).map((s) => s.name))
        .toEqual(['cron-schedule']);
    });

    it('leaves skills from plugins that are not userGrantable unaffected', () => {
      const reg = new PluginRegistry();
      reg.contextFor('files', {}, noopLog).registerSkill(fakeSkill('file-workflow'));

      expect(reg.skillsFor(4, accessUser()).map((s) => s.name)).toEqual(['file-workflow']);
    });

    it('fails closed for a caller with no account while preserving instance-wide open skills', () => {
      const reg = new PluginRegistry();
      reg.contextFor('cronjob', {}, noopLog).registerSkill(fakeSkill('cron-schedule'));
      reg.contextFor('files', {}, noopLog).registerSkill(fakeSkill('file-workflow'));
      reg.setUserGrantable('cronjob', true);

      expect(reg.skillsFor(null).map((s) => s.name)).toEqual(['file-workflow']);
      expect(reg.skillsFor(undefined).map((s) => s.name)).toEqual(['file-workflow']);
    });

    it('carries ownership and grant metadata through a merge of two registries', () => {
      const a = new PluginRegistry();
      a.contextFor('files', {}, noopLog).registerSkill(fakeSkill('shared'));
      const b = new PluginRegistry();
      const gated = b.contextFor('skills', {}, noopLog);
      gated.registerSkill(fakeSkill('gated-shared'));
      gated.registerSkill(fakeSkill('amy-only'), { ownerUserId: 4 });
      b.setUserGrantable('skills', true);
      a.merge(b);
      expect(a.skillsFor(4, accessUser({ granted_plugins: ['skills'] })).map((s) => s.name)).toEqual(['shared', 'gated-shared', 'amy-only']);
      expect(a.skillsFor(5, accessUser()).map((s) => s.name)).toEqual(['shared']);
    });
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

  describe('ctx.chatCommands (single source for chat surfaces)', () => {
    // The many `undefined`s skip the optional wiring params; the last arg is the lazy plugin-command
    // provider the loader normally closes over the merged registry (here a fixed list).
    const U = undefined;
    it('returns built-ins WITH their kind, then plugin prompt commands from the lazy provider', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('ops', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => [{ name: 'deploy', description: 'Ship it to $1', prompt: 'Deploy to $1', plugin: 'ops' }]);
      const cmds = ctx.chatCommands('discord');
      // built-ins carry their kind…
      expect(cmds.find((c) => c.name === 'help')).toMatchObject({ kind: 'info' });
      expect(cmds.find((c) => c.name === 'model')).toMatchObject({ kind: 'picker' });
      // …and the plugin prompt command is merged in with kind:'prompt'.
      expect(cmds.find((c) => c.name === 'deploy')).toMatchObject({ name: 'deploy', description: 'Ship it to $1', kind: 'prompt' });
      // built-ins come before the plugin command
      expect(cmds.findIndex((c) => c.name === 'help')).toBeLessThan(cmds.findIndex((c) => c.name === 'deploy'));
    });

    /** THE reason an adapter needed a parallel command list: this projection used to hand over `kind` and
     *  nothing about HOW a command runs, so "is this one of mine?" could only be answered by a hardcoded
     *  name set, which drifted from the catalog silently. With `execution` on the wire the adapter's
     *  control set is a derived value, and this asserts the projection still carries what the derivation
     *  reads — run through the real `controlCommandsFrom`, so the rule is not restated here either. */
    it('carries `execution` so an adapter can derive its control set instead of hardcoding one', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('ops', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => [{ name: 'deploy', description: 'Ship it', prompt: 'Deploy to $1', plugin: 'ops' }]);
      const cmds = ctx.chatCommands('discord');
      expect(cmds.find((c) => c.name === 'stats')).toMatchObject({ kind: 'info', execution: 'session-control' });
      expect(cmds.find((c) => c.name === 'model')).toMatchObject({ kind: 'picker', execution: 'surface-local' });
      expect(cmds.find((c) => c.name === 'deploy')).toMatchObject({ kind: 'prompt', execution: 'plugin-prompt' });
      expect(cmds.every((c) => typeof c.execution === 'string')).toBe(true);
      // The six the shared control core owns, derived from what this call publishes.
      expect([...controlCommandsFrom(cmds) as Set<string>].sort()).toEqual(['compact', 'fast', 'new', 'restart', 'stats', 'stop']);
    });

    /** A portable argument set travels with the command, so an adapter builds its option schema from the
     *  catalog rather than restating the values. Only `/fast` declares one today; a command that does not
     *  must not grow an empty `argument` key that an adapter would render as a choiceless option. */
    it('carries a declared `argument` and omits the key entirely when there is none', () => {
      const reg = new PluginRegistry();
      const cmds = reg.contextFor('ops', {}, noopLog).chatCommands('discord');
      expect(cmds.find((c) => c.name === 'fast')?.argument).toEqual({ kind: 'enum', values: ['on', 'off', 'status'] });
      expect(cmds.find((c) => c.name === 'compact')).not.toHaveProperty('argument');
    });

    /** `voice`/`display` are declared in the catalog as `adapter-state` but every adapter still registers
     *  them itself; handing them back here would put the same name twice in one Discord bulk registration,
     *  a 400 that drops every slash command for the guild. */
    it('never publishes an adapter-owned command back to the adapter that owns it', () => {
      const reg = new PluginRegistry();
      for (const surface of ['discord', 'telegram', 'msteams', 'whatsapp'] as const) {
        const names = reg.contextFor('ops', {}, noopLog).chatCommands(surface).map((c) => c.name);
        expect(names, surface).not.toContain('voice');
        expect(names, surface).not.toContain('display');
      }
    });

    /** A plugin picker reaches the adapter as a surface-local picker, not as a prompt macro — which is
     *  what tells the surface to draw its own chooser instead of sending a slash to the brain. */
    it('publishes a plugin picker command as kind:"picker" + execution:"surface-local"', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('sbx', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => [{ name: 'workspace', description: 'Pick a workspace', kind: 'picker' as const, plugin: 'sbx' }]);
      const cmd = ctx.chatCommands('discord').find((c) => c.name === 'workspace');
      expect(cmd).toMatchObject({ kind: 'picker', execution: 'surface-local' });
    });

    it('honours a plugin command\'s surface restriction', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('ops', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => [{ name: 'lint', description: 'Lint', prompt: 'lint it', surfaces: ['telegram'], plugin: 'ops' }]);
      expect(ctx.chatCommands('telegram').some((c) => c.name === 'lint')).toBe(true);
      expect(ctx.chatCommands('discord').some((c) => c.name === 'lint')).toBe(false);
    });

    it('with no provider wired (unit context) returns only built-ins', () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('ops', {}, noopLog);
      const cmds = ctx.chatCommands('whatsapp');
      expect(cmds.every((c) => typeof c.kind === 'string')).toBe(true);
      expect(cmds.some((c) => c.name === 'help')).toBe(true);
    });
  });

  // The operator's sub-agent context budget travels through a long positional wiring chain
  // (bootstrap → loadPlugins → contextFor), which is exactly where a mis-ordered argument hides: the
  // delegating plugin would silently keep its built-in default whatever the operator configured.
  describe('ctx.delegateContextChars', () => {
    const U = undefined;
    it('exposes the wired budget live, and falls back to the default without one', () => {
      const reg = new PluginRegistry();
      let configured = 12_345;
      const ctx = reg.contextFor('subagent', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => configured);
      expect(ctx.delegateContextChars()).toBe(12_345);
      configured = 8_000;
      expect(ctx.delegateContextChars()).toBe(8_000); // read live, not captured at register time
      expect(reg.contextFor('subagent', {}, noopLog).delegateContextChars())
        .toBe(DEFAULT_BRAIN_LIMITS.delegateContextChars);
    });
  });

  describe('registerTurnContext', () => {
    it('defaults to before-user and preserves an explicit after-user placement through merge()', () => {
      const staged = new PluginRegistry();
      const ctx = staged.contextFor('contextual', {}, noopLog);
      const before = () => 'before';
      const after = () => 'after';
      ctx.registerTurnContext(before);
      ctx.registerTurnContext(after, { placement: 'after-user' });

      const reg = new PluginRegistry();
      reg.merge(staged);

      expect(reg.turnContexts).toEqual([
        { render: before, placement: 'before-user' },
        { render: after, placement: 'after-user' },
      ]);
      expect(reg.turnContextOwners).toEqual(['contextual', 'contextual']);
    });
  });

  describe('ctx.embeddings gate (deny-by-default, single-source config)', () => {
    // A fake embedder that records the config it was called with, so we can prove the LIVE config is
    // bound internally and forwarded on every call.
    const makeEmbedder = () => {
      const seen: EmbeddingConfig[] = [];
      return {
        seen,
        embed: async (cfg: EmbeddingConfig, text: string) => { seen.push(cfg); return Float32Array.from([text.length, cfg.model.length]); },
        embedBatch: async (cfg: EmbeddingConfig, texts: string[]) => { seen.push(cfg); return texts.map((t) => Float32Array.from([t.length])); },
      };
    };
    const configured: EmbeddingConfig = { providerId: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };

    it('permits embed() and reports configured/descriptor when reads:["embeddings"] is declared', async () => {
      const reg = new PluginRegistry();
      const emb = makeEmbedder();
      const ctx = reg.contextFor('sem', {}, noopLog, undefined, undefined, undefined, undefined, { reads: ['embeddings'] }, undefined, undefined, emb, () => configured);
      expect(ctx.embeddings.isConfigured()).toBe(true);
      expect(ctx.embeddings.descriptor()).toEqual({ provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 });
      const vec = await ctx.embeddings.embed('hello');
      expect(Array.from(vec)).toEqual([5, 'text-embedding-3-small'.length]);
      expect(emb.seen[0]).toEqual(configured); // the bound Settings→Memory config, not a plugin field
    });

    it('is deny-by-default: without the capability, isConfigured()===false, descriptor()===null, embed() rejects', async () => {
      const reg = new PluginRegistry();
      const emb = makeEmbedder();
      const ctx = reg.contextFor('nocap', {}, noopLog, undefined, undefined, undefined, undefined, {}, undefined, undefined, emb, () => configured);
      expect(ctx.embeddings.isConfigured()).toBe(false);
      expect(ctx.embeddings.descriptor()).toBeNull();
      await expect(ctx.embeddings.embed('x')).rejects.toThrow(/capability/);
      await expect(ctx.embeddings.embedBatch(['x'])).rejects.toThrow(/capability/);
      expect(emb.seen).toHaveLength(0); // the embedder was never reached
    });

    it('rejects with "not configured" when the capability is declared but no embedding model is set', async () => {
      const reg = new PluginRegistry();
      const emb = makeEmbedder();
      const empty: EmbeddingConfig = { providerId: '', model: '', dimensions: undefined };
      const ctx = reg.contextFor('sem', {}, noopLog, undefined, undefined, undefined, undefined, { reads: ['embeddings'] }, undefined, undefined, emb, () => empty);
      expect(ctx.embeddings.isConfigured()).toBe(false);
      expect(ctx.embeddings.descriptor()).toBeNull();
      await expect(ctx.embeddings.embed('x')).rejects.toThrow(/not configured/);
    });

    it('forwards the LIVE config on every call (a model switch applies without a reload)', async () => {
      const reg = new PluginRegistry();
      const emb = makeEmbedder();
      let live: EmbeddingConfig = configured;
      const ctx = reg.contextFor('sem', {}, noopLog, undefined, undefined, undefined, undefined, { reads: ['embeddings'] }, undefined, undefined, emb, () => live);
      await ctx.embeddings.embed('a');
      live = { providerId: 'local', model: 'nomic-embed', dimensions: 768 };
      await ctx.embeddings.embed('b');
      expect(ctx.embeddings.descriptor()).toEqual({ provider: 'local', model: 'nomic-embed', dimensions: 768 });
      expect(emb.seen.map((c) => c.model)).toEqual(['text-embedding-3-small', 'nomic-embed']);
    });
  });

  describe('setShowOutput (tool-output policy)', () => {
    it('collects a plugin manifest\'s showOutput patterns, trims blanks, and is idempotent', () => {
      const reg = new PluginRegistry();
      reg.setShowOutput(['Bash', ' ProcessOutput ', 'Lsp*']);
      reg.setShowOutput(['Bash', 'ScanCode', '', '   ']); // re-declares + blanks dropped
      expect([...reg.toolShowOutput].sort()).toEqual(['Bash', 'Lsp*', 'ProcessOutput', 'ScanCode']);
    });
  });

  describe('setPlanSafe (what plan mode may compose)', () => {
    it('collects a manifest\'s plan-safe tool names, trims blanks, and is idempotent', () => {
      const reg = new PluginRegistry();
      reg.setPlanSafe(['Read', ' ListDir ', ''], undefined);
      reg.setPlanSafe(['Read', 'FileInfo', '   '], undefined);
      expect([...reg.toolPlanSafe].sort()).toEqual(['FileInfo', 'ListDir', 'Read']);
    });

    it('refuses a plan-safe claim for a tool the manifest never declared', () => {
      const reg = new PluginRegistry();
      const warnings: string[] = [];
      // A manifest that declares provides.tools may only vouch for its own tools — otherwise it could
      // hand plan mode another plugin's destructive tool by naming it here.
      reg.setPlanSafe(['Read', 'Bash'], { tools: ['Read'] }, (m) => warnings.push(m));
      expect([...reg.toolPlanSafe]).toEqual(['Read']);
      expect(warnings).toEqual(["planSafe 'Bash' ignored: not declared in provides.tools"]);
    });

    it('leaves a manifest without provides.tools unconstrained, exactly like registerTool', () => {
      const reg = new PluginRegistry();
      reg.setPlanSafe(['ListSkills'], { skills: ['*'] });
      expect([...reg.toolPlanSafe]).toEqual(['ListSkills']);
    });

    it('an undefined/empty manifest field contributes nothing', () => {
      const reg = new PluginRegistry();
      reg.setShowOutput(undefined);
      reg.setShowOutput([]);
      expect(reg.toolShowOutput.size).toBe(0);
    });
  });

  describe('setDeferLoading (owner-scoped ToolSearch defaults)', () => {
    const tool = (name: string) => ({ name } as never);

    it('expands exact and prefix patterns only to the declaring plugin\'s registered tools', () => {
      const reg = new PluginRegistry();
      reg.contextFor('mcp', {}, noopLog).registerTool(tool('mcp__github__create_issue'));
      reg.contextFor('mcp', {}, noopLog).registerTool(tool('mcp__github__list_issues'));
      reg.contextFor('discord', {}, noopLog).registerTool(tool('mcp__discord__admin'));
      reg.contextFor('discord', {}, noopLog).registerTool(tool('DiscordCreateChannel'));

      reg.setDeferLoading('mcp', ['mcp__*']);
      reg.setDeferLoading('discord', ['DiscordCreateChannel']);

      expect([...reg.toolDeferLoading].sort()).toEqual([
        'DiscordCreateChannel',
        'mcp__github__create_issue',
        'mcp__github__list_issues',
      ]);
    });

    it('warns and stores no global pattern when an owner has no matching tool', () => {
      const reg = new PluginRegistry();
      const warnings: string[] = [];
      reg.contextFor('owner', {}, noopLog).registerTool(tool('OwnerTool'));
      reg.contextFor('other', {}, noopLog).registerTool(tool('OtherTool'));

      reg.setDeferLoading('owner', ['Other*', 'MissingTool'], (message) => warnings.push(message));

      expect([...reg.toolDeferLoading]).toEqual([]);
      expect(warnings).toEqual([
        "deferLoading 'Other*' ignored: no matching tools registered by 'owner'",
        "deferLoading 'MissingTool' ignored: no matching tools registered by 'owner'",
      ]);
    });
  });

  describe('registerTool manifest gating', () => {
    const U = undefined;
    const tool = (name: string) => ({ name } as never);

    it('accepts declared names, refuses undeclared ones', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const log = { info() {}, warn: (m: string) => warns.push(m), error() {} };
      const ctx = reg.contextFor('demo', {}, log, U, U, U, U, U, { tools: ['Read'] });
      ctx.registerTool(tool('Read'));
      ctx.registerTool(tool('Write'));
      expect(reg.tools.map((t) => t.name)).toEqual(['Read']);
      expect(warns).toEqual(["[plugin:demo] registerTool('Write') refused: not declared in manifest provides.tools"]);
    });

    it('a `prefix*` declaration covers a dynamic tool surface — the mcp bridge names its tools at runtime', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const log = { info() {}, warn: (m: string) => warns.push(m), error() {} };
      const ctx = reg.contextFor('mcp', {}, log, U, U, U, U, U, { tools: ['ListMcpResources', 'mcp__*'] });
      ctx.registerTool(tool('ListMcpResources'));
      ctx.registerTool(tool('mcp__github__create_issue'));
      ctx.registerTool(tool('SomethingElse')); // NOT covered — the pattern only widens its own prefix
      expect(reg.tools.map((t) => t.name)).toEqual(['ListMcpResources', 'mcp__github__create_issue']);
      expect(warns).toEqual(["[plugin:mcp] registerTool('SomethingElse') refused: not declared in manifest provides.tools"]);
    });
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

    it('refuses an adapter-owned reserved name (voice/display) so it cannot collide with the native slash', () => {
      // These ARE declared in SLASH_COMMANDS (`execution: 'adapter-state'`) but published to no surface —
      // the declaration exists precisely to reserve the name. They are dispatched by the Discord/Telegram
      // adapters against their own channel state; a plugin macro of the same name would break Discord's
      // bulk registration and shadow the built-in inconsistently.
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('p', {}, { info() {}, warn: (m: string) => warns.push(m), error() {} });
      ctx.registerCommand({ name: 'voice', description: 'x', prompt: 'y' });
      ctx.registerCommand({ name: 'display', description: 'x', prompt: 'y' });
      expect(reg.commands.has('voice')).toBe(false);
      expect(reg.commands.has('display')).toBe(false);
      expect(warns.length).toBe(2);
    });

    /** The second kind a plugin may declare: a command a SURFACE draws as its own chooser. The plugin
     *  owns the declaration (so the same registry gate that hides a disabled plugin's macros hides this
     *  too), the surface owns the renderer. It stores `kind:'picker'` and carries no prompt. */
    it('accepts a picker command and stores its kind without a prompt', () => {
      const reg = new PluginRegistry();
      reg.contextFor('sbx', {}, noopLog).registerCommand({ name: 'workspace', description: 'Pick a workspace', kind: 'picker' });
      expect(reg.commands.get('workspace')).toMatchObject({ name: 'workspace', kind: 'picker' });
      expect(reg.commands.get('workspace')?.prompt).toBeUndefined();
      expect(reg.commandOwner.get('workspace')).toBe('sbx');
    });

    it('stamps kind:"prompt" on a command that declares none (every pre-existing caller)', () => {
      const reg = new PluginRegistry();
      reg.contextFor('ops', {}, noopLog).registerCommand({ name: 'deploy', description: 'Ship', prompt: 'Deploy $ARGS' });
      expect(reg.commands.get('deploy')).toMatchObject({ kind: 'prompt', prompt: 'Deploy $ARGS' });
    });

    /** A picker never reaches the model, so a prompt on one is a declaration nothing can ever run —
     *  refused loudly rather than half-registered. */
    it('refuses a picker command that carries a prompt', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('sbx', {}, { info() {}, warn: (m: string) => warns.push(m), error() {} });
      ctx.registerCommand({ name: 'workspace', description: 'x', kind: 'picker', prompt: 'do it' });
      expect(reg.commands.has('workspace')).toBe(false);
      expect(warns.some((w) => w.includes('workspace'))).toBe(true);
    });

    it('still refuses a picker whose name shadows a built-in or an adapter-owned command', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('sbx', {}, { info() {}, warn: (m: string) => warns.push(m), error() {} });
      ctx.registerCommand({ name: 'help', description: 'x', kind: 'picker' });
      ctx.registerCommand({ name: 'voice', description: 'x', kind: 'picker' });
      expect(reg.commands.has('help')).toBe(false);
      expect(reg.commands.has('voice')).toBe(false);
      expect(warns.length).toBe(2);
    });

    /** A picker is DRAWN by the surface that runs it, and only the CLI and the web dock hold a renderer
     *  registry to draw one with. A chat adapter that claimed the command would register the name into
     *  its platform's native menu and then have nothing to answer the invocation with, so the surfaces a
     *  picker may be published to are decided HERE rather than trusted from the declaration. */
    it('defaults a picker to the surfaces that can draw it', () => {
      const reg = new PluginRegistry();
      reg.contextFor('sbx', {}, noopLog).registerCommand({ name: 'workspace', description: 'Pick a workspace', kind: 'picker' });
      expect(reg.commands.get('workspace')?.surfaces).toEqual(['cli', 'web']);
    });

    it('drops a platform surface from a picker so no chat adapter can claim it', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('sbx', {}, { info() {}, warn: (m: string) => warns.push(m), error() {} });
      ctx.registerCommand({ name: 'workspace', description: 'Pick a workspace', kind: 'picker', surfaces: ['web', 'discord'] });
      expect(reg.commands.get('workspace')?.surfaces).toEqual(['web']);
      expect(warns.some((w) => w.includes('discord'))).toBe(true);
    });

    it('refuses a picker whose declared surfaces are all platforms', () => {
      const warns: string[] = [];
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('sbx', {}, { info() {}, warn: (m: string) => warns.push(m), error() {} });
      ctx.registerCommand({ name: 'workspace', description: 'x', kind: 'picker', surfaces: ['discord', 'telegram'] });
      expect(reg.commands.has('workspace')).toBe(false);
      expect(warns.some((w) => w.includes('workspace'))).toBe(true);
    });

    /** The end the clamp exists for: a platform's PUBLISHED menu, which is what an adapter registers. */
    it('never publishes a platform-declared picker into that platform\u2019s menu', () => {
      const reg = new PluginRegistry();
      const U = undefined;
      const ctx = reg.contextFor('sbx', {}, noopLog, U, U, U, U, U, U, U, U, U, U, U, U, U,
        () => [...reg.commands.values()].map((cmd) => ({ ...cmd, plugin: reg.commandOwner.get(cmd.name) })));
      ctx.registerCommand({ name: 'workspace', description: 'Pick a workspace', kind: 'picker', surfaces: ['cli', 'web', 'discord'] });
      reg.setCapabilities('sbx', {}); // what the loader records for a plugin that registered cleanly

      expect(ctx.chatCommands('discord').some((cmd) => cmd.name === 'workspace')).toBe(false);
      // …and it IS published where a renderer exists, so the clamp narrows rather than deletes.
      expect(ctx.chatCommands('web').some((cmd) => cmd.name === 'workspace')).toBe(true);
    });

    /** Prompt macros keep their unrestricted reach: a macro expands to a model turn, which every surface
     *  can run — a chat platform included. */
    it('leaves a prompt macro\u2019s declared surfaces untouched', () => {
      const reg = new PluginRegistry();
      reg.contextFor('ops', {}, noopLog).registerCommand({ name: 'deploy', description: 'Ship', prompt: 'Deploy $ARGS', surfaces: ['discord'] });
      expect(reg.commands.get('deploy')?.surfaces).toEqual(['discord']);
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

    it('enforces first-writer-wins for a cross-plugin tool-name collision at merge()', () => {
      const warns: string[] = [];
      const base = new PluginRegistry();
      const a = new PluginRegistry();
      a.contextFor('a', {}, noopLog).registerTool({ name: 'Dup', description: 'A' } as never);
      const b = new PluginRegistry();
      b.contextFor('b', {}, noopLog).registerTool({ name: 'Dup', description: 'B' } as never);
      base.merge(a);
      base.merge(b, (m) => warns.push(m));
      // The loser's definition must not be kept either: two entries under one name would be dispatched
      // and reported as the winner's.
      expect(base.tools).toHaveLength(1);
      expect(base.tools[0]?.description).toBe('A');
      expect(base.toolOwner.get('Dup')).toBe('a');
      expect(warns.some((w) => w.includes('Dup'))).toBe(true);
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

  describe('notification destinations', () => {
    it('normalizes declared provider rows into opaque routed values', async () => {
      const reg = new PluginRegistry();
      const ctx = reg.contextFor('teams', {}, noopLog, undefined, undefined, undefined, undefined, {}, { destinations: ['msteams'] });
      ctx.registerNotificationDestinationProvider({
        platform: 'msteams',
        list: async () => [{ id: 'a:chat', kind: 'person', label: 'Filip', group: 'Microsoft Teams' }],
      });
      expect(await reg.notificationDestinations()).toEqual([{
        value: 'destination:msteams:a%3Achat', id: 'a:chat', platform: 'msteams', kind: 'person', label: 'Filip', group: 'Microsoft Teams',
      }]);
    });

    it('times out one stuck provider without withholding healthy platform rows', async () => {
      vi.useFakeTimers();
      try {
        const reg = new PluginRegistry();
        const slow = reg.contextFor('slow', {}, noopLog, undefined, undefined, undefined, undefined, {}, { destinations: ['discord'] });
        slow.registerNotificationDestinationProvider({ platform: 'discord', list: () => new Promise(() => {}) });
        const fast = reg.contextFor('fast', {}, noopLog, undefined, undefined, undefined, undefined, {}, { destinations: ['msteams'] });
        fast.registerNotificationDestinationProvider({ platform: 'msteams', list: () => [{ id: 'a:chat', kind: 'chat', label: 'Chat' }] });
        const pending = reg.notificationDestinations();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await pending).toEqual([{
          value: 'destination:msteams:a%3Achat', id: 'a:chat', platform: 'msteams', kind: 'chat', label: 'Chat',
        }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses an undeclared provider and drops malformed rows', async () => {
      const warns: string[] = [];
      const log = { info() {}, warn: (message: string) => warns.push(message), error() {} };
      const reg = new PluginRegistry();
      reg.contextFor('bad', {}, log).registerNotificationDestinationProvider({ platform: 'discord', list: () => [] });
      const ctx = reg.contextFor('teams', {}, log, undefined, undefined, undefined, undefined, {}, { destinations: ['msteams'] });
      ctx.registerNotificationDestinationProvider({ platform: 'msteams', list: () => [{ id: '', kind: 'chat', label: '' }] });
      expect(await reg.notificationDestinations()).toEqual([]);
      expect(warns.some((warning) => warning.includes('not declared'))).toBe(true);
      expect(warns.some((warning) => warning.includes('malformed row'))).toBe(true);
    });
  });
});
