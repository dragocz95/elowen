import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { DelegatedChildBridge } from '../../src/plugins/api.js';
import type { SubagentUpdate } from '../../src/brain/events.js';

// A DelegateContinue that switches the child's model must publish the identity the child ACTUALLY runs
// on as soon as the host has rebuilt the session — the `session` event fires exactly there, before any
// generated text — not only on the first tool call, which a tool-less reply never produces.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true, conversation: 'own' };
const CHILD = 'brain-ch-subagent-sub-dlg-continue';

interface ToolResult { content: { text: string }[]; details?: Record<string, unknown> }
interface Executable { execute(id: string, p: unknown): Promise<ToolResult> }

describe('DelegateContinue publishes the rebuilt child identity before any generation', () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-continue-'));
  });
  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = (continueBridge: DelegatedChildBridge['continue']) =>
    loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot, logger: log,
      delegatedTurnsOutOfProcess: () => false,
      delegatedChildren: {
        runs: () => [],
        read: () => { throw new Error('not used in this suite'); },
        continue: continueBridge,
        stop: async () => ({ stopped: false }),
      },
    });

  const tool = (reg: PluginRegistry, name: string): Executable => {
    const found = reg.tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} not registered`);
    return found as unknown as Executable;
  };

  let emitted: SubagentUpdate[] = [];
  const runContinue = async (reg: PluginRegistry, params: Record<string, unknown>): Promise<ToolResult> => {
    emitted = [];
    return runWithPolicy(
      adminPolicy,
      () => tool(reg, 'DelegateContinue').execute('call-continue', params),
      {
        identity: owner,
        sessionId: 'brain-1',
        emitSubagent: (update: SubagentUpdate) => { emitted.push(update); },
        emitSubagentCompletion: () => {},
      },
    );
  };

  it('re-publishes the row on the child session event even when NO tool ever runs', async () => {
    let emissionsAtSessionEvent = -1;
    const reg = await load(async (_parent, childSessionId, _text, _access, onEvent) => {
      // The host emits `session` right after the respawn (new model applied), before prompting. Mark
      // how many rows existed at that moment: the rebuilt identity must arrive as a NEW row AFTER it.
      onEvent?.({ type: 'session', sessionId: childSessionId });
      emissionsAtSessionEvent = emitted.length;
      return { status: 'reply', reply: 'answered without touching a tool' };
    });
    const res = await runContinue(reg, { id: CHILD, message: 'switch approach' });
    expect(res.content[0]?.text).toContain('answered without touching a tool');
    // The initial pre-spawn push lands BEFORE the session event (that is the stale one); without the
    // session-event push a tool-less continuation would stop there and never publish the identity the
    // rebuilt child actually runs on.
    expect(emissionsAtSessionEvent).toBeGreaterThanOrEqual(1);
    expect(emitted.length).toBeGreaterThan(emissionsAtSessionEvent);
    // The FIRST push after the session event is the re-published running row (the reply's terminal
    // `done` push may follow it).
    expect(emitted[emissionsAtSessionEvent]).toMatchObject({ status: 'running', sessionId: CHILD });
  });

  it('passes an explicit model switch through to the host bridge', async () => {
    let seenModel: string | undefined;
    const reg = await load(async (_parent, _child, _text, _access, _onEvent, model) => {
      seenModel = model;
      return { status: 'reply', reply: 'done' };
    });
    await runContinue(reg, { id: CHILD, message: 'continue on the other model', model: 'kimi-coding/k3' });
    expect(seenModel).toBe('kimi-coding/k3');
  });
});
