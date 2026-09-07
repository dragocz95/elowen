import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

// `brain.forkParentContext` is a shipped operator toggle: on, a Delegate call that says nothing about
// `fork` should fork. But only an OWNER conversation can fork at all — a sub-agent is a worker already and
// a shared room's session is a channel the host refuses. Resolving the default before those guards made
// the toggle refuse every nested and every channel delegation, which is every collect-turn and every
// workflow-node delegation on an instance that turned it on.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

const ownerChat: TurnIdentity = {
  platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true, conversation: 'own',
};
const insideSubagent: TurnIdentity = {
  platform: 'subagent', userId: 'subagent', elowenUserId: 1, admin: true, owner: true, conversation: 'delegated',
};
const sharedChannel: TurnIdentity = {
  platform: 'discord', userId: '42', elowenUserId: 1, admin: true, owner: true, conversation: 'shared',
};

interface ToolResult { content: { text: string }[]; details?: Record<string, unknown> }
interface Executable { execute(id: string, p: unknown): Promise<ToolResult> }

describe('Delegate fork — the instance default applies only where a fork is possible', () => {
  let dataRoot: string;
  beforeEach(() => { dataRoot = mkdtempSync(join(tmpdir(), 'subagent-fork-default-')); });
  afterEach(() => { rmSync(dataRoot, { recursive: true, force: true }); });

  /** Load the plugin with the operator toggle ON — the configuration this bug needs to appear at all. */
  const load = (forkParentContext: boolean) => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot, logger: log,
    forkParentContext: () => forkParentContext,
    delegatedChildren: {
      runs: () => [],
      read: () => { throw new Error('not used in this suite'); },
      continue: async () => { throw new Error('not used in this suite'); },
      stop: async () => ({ stopped: false }),
    },
  });

  const tool = (reg: PluginRegistry, name: string): Executable => {
    const found = reg.tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} not registered`);
    return found as unknown as Executable;
  };

  /** Run one blocking delegation and report what the HOST was asked for: the refusal text, or the `fork`
   *  flag on the immutable access the spawn would carry. */
  const delegate = async (
    reg: PluginRegistry,
    identity: TurnIdentity,
    params: Record<string, unknown>,
  ): Promise<{ text: string; forked?: boolean }> => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    let forked: boolean | undefined;
    platform.listen(async (src: { access?: { fork?: boolean } }, _task: string, onEvent?: (e: unknown) => void) => {
      forked = src.access?.fork === true;
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-fork-default' });
      return 'the child conclusion';
    });
    const res = await runWithPolicy(
      adminPolicy,
      () => tool(reg, 'Delegate').execute('call-fork', { task: 'a delegated task', ...params }),
      { identity, sessionId: 'brain-1', emitSubagent: () => {}, emitSubagentCompletion: () => {} },
    );
    return { text: res.content[0]?.text ?? '', ...(forked === undefined ? {} : { forked }) };
  };

  it('forks an owner-chat delegation that omits the flag', async () => {
    const reg = await load(true);
    const res = await delegate(reg, ownerChat, {});
    expect(res.text).toContain('the child conclusion');
    expect(res.forked).toBe(true);
  });

  // The regression: with the toggle on, a sub-agent delegating further omitted `fork`, the default turned
  // it on, and the guard two lines later refused the call. Nested delegation stopped working entirely.
  it('runs a nested delegation that omits the flag instead of refusing it', async () => {
    const reg = await load(true);
    const res = await delegate(reg, insideSubagent, {});
    expect(res.text).not.toContain('Error:');
    expect(res.text).toContain('the child conclusion');
    expect(res.forked).toBe(false);
  });

  // Silently off is for an OMITTED flag only. Asking for a fork from a worker is still a mistake worth
  // naming, and the answer has to say the caller already is the fork rather than claim a missing tool.
  it('still refuses an explicit fork from inside a sub-agent', async () => {
    const reg = await load(true);
    const res = await delegate(reg, insideSubagent, { fork: true });
    expect(res.text).toContain('you ARE a worker already');
    expect(res.forked).toBeUndefined();
  });

  // The same trap on the other side: a shared room passed the plugin and was then rejected by the host
  // with its raw boundary error, so every channel delegation failed.
  it('runs a shared-channel delegation that omits the flag, and names the refusal for an explicit one', async () => {
    const reg = await load(true);
    const omitted = await delegate(reg, sharedChannel, {});
    expect(omitted.text).toContain('the child conclusion');
    expect(omitted.forked).toBe(false);

    const explicit = await delegate(reg, sharedChannel, { fork: true });
    expect(explicit.text).toContain('only available in an owner conversation');
  });

  it('leaves an owner-chat delegation unforked while the toggle is off', async () => {
    const reg = await load(false);
    const res = await delegate(reg, ownerChat, {});
    expect(res.forked).toBe(false);
  });

  // The "when to fork" guidance is split across the system prompt, this tool's description and the `fork`
  // parameter, and all three have to say the same thing. The sentence worth pinning hardest is the one
  // about the model: a fork buys the provider's cached prefix, and Elowen routinely runs sub-agents on
  // another provider or model, where a fork inherits the context and shares no cache at all.
  it('states the fork criterion and the same-model condition in the tool description', async () => {
    const reg = await load(false);
    const description = reg.tools.find((t) => t.name === 'Delegate')?.description ?? '';
    expect(description).toContain('a fork inherits your full conversation context');
    expect(description).toContain('"will I need this output again" — not task size');
    expect(description).toContain('only when the child runs on the SAME provider and model as the parent');
  });

  it('gives the `fork` parameter the when-to-fork guidance and the fresh-sub-agent exit', async () => {
    const reg = await load(false);
    const schema = reg.tools.find((t) => t.name === 'Delegate')?.parameters as
      { properties?: { fork?: { description?: string } } } | undefined;
    const fork = schema?.properties?.fork?.description ?? '';
    expect(fork).toContain('a fork inherits your full conversation context');
    expect(fork).toContain('"will I need this output again" — not task size');
    expect(fork).toContain('only when the child runs on the SAME provider and model as the parent');
    expect(fork).toContain('delegate a fresh sub-agent when you need any of them');
  });
});
