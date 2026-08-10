import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrainCore } from '../../src/daemon/brainCore.js';
import { createWorkflowHostRpc } from '../../src/daemon/bootstrap.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';
import type { DelegatedTurnRunner } from '../../src/brain/delegatedTurn.js';
import { WORKFLOW_ADD_NODES_RPC } from '../../src/subagent/hostRpc.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const temp = mkdtempSync(join(tmpdir(), 'elowen-workflow-rpc-wiring-'));
afterAll(() => { rmSync(temp, { recursive: true, force: true }); });

interface CapturedSource {
  access?: { context?: string[]; toolPolicy?: { deny?: string[] } };
}
interface ExecutableTool {
  name: string;
  execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
}

const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const policy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };

// This test deliberately constructs the production core rather than hand-feeding loadPlugins callbacks.
// Deleting the brainCore → loader capability wiring leaves SubagentDispatch in runner mode but makes the
// loaded workflow engine deny the tool, so the assertion below goes red.
describe('brainCore workflow RPC capability wiring', () => {
  it('carries the runner capability through the real plugin provider into remote node access', async () => {
    const state = { rpc: true };
    const runner: DelegatedTurnRunner = {
      run: async () => 'unused',
      abort: () => {},
      steer: async () => ({ outcome: 'idle' }),
      release: async () => ({ busy: false }),
      reset: () => {},
      usable: () => true,
      supportsHostRpc: (method) => method === WORKFLOW_ADD_NODES_RPC && state.rpc,
    };
    const core = await buildBrainCore({
      dbPath: join(temp, 'brain.sqlite'),
      project: { id: 1, slug: 'wiring', path: temp },
      tmux: new FakeTmuxDriver(),
      bootstrap: null,
      subagentRunner: runner,
      pluginDirs: [join(repoRoot, 'plugins')],
    });
    try {
      core.config.update({ plugins: { enabled: ['subagent'] }, runtime: { subagentRunnerEnabled: true } });
      const registry = await core.pluginProvider.get();
      const captured: CapturedSource[] = [];
      registry.platforms.find((platform) => platform.name === 'subagent')!.listen((async (source: CapturedSource, task: string, onEvent?: (event: unknown) => void) => {
        captured.push(source);
        onEvent?.({ type: 'session', sessionId: `brain-ch-${task}` });
        return `done:${task}`;
      }) as Parameters<(typeof registry.platforms)[number]['listen']>[0]);
      const start = registry.tools.find((candidate) => candidate.name === 'WorkflowStart') as unknown as ExecutableTool;
      let fileCount = 0;
      const run = async (task: string) => {
        const nodesFile = join(temp, `workflow-${fileCount++}.json`);
        writeFileSync(nodesFile, JSON.stringify([{ id: 'root', task }]));
        return runWithPolicy(policy, () => start.execute(`call-${task}`, { nodesFile }), {
          identity: owner,
          sessionId: 'brain-owner',
          workDir: temp,
        });
      };

      await run('rpc-present');
      expect((captured[0]?.access?.context ?? []).join('\n')).toContain('WorkflowAddNodes');
      expect(captured[0]?.access?.toolPolicy?.deny ?? []).not.toContain('WorkflowAddNodes');

      state.rpc = false;
      await run('rpc-missing');
      expect((captured[1]?.access?.context ?? []).join('\n')).not.toContain('WorkflowAddNodes');
      expect(captured[1]?.access?.toolPolicy?.deny).toContain('WorkflowAddNodes');
    } finally {
      core.db.close();
    }
  });

  it('rechecks caller liveness after plugin lookup and before mutation', async () => {
    const registry = new PluginRegistry();
    const ctx = registry.contextFor('subagent', {}, { info() {}, warn() {}, error() {} });
    const mutations: unknown[] = [];
    ctx.registerControl('workflow', {
      cancelForSession: () => ({ cancelled: 0 }),
      detachForeground: () => ({ detached: 0 }),
      activeCount: () => 0,
      isWorkflowLive: () => true,
      addNodesFromSession: (input: unknown) => { mutations.push(input); return { added: ['late'] }; },
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolveLookup) => { releaseLookup = resolveLookup; });
    const rpc = createWorkflowHostRpc(async () => { await lookupGate; return registry; });
    let active = true;
    const pending = rpc({
      sessionId: 'brain-ch-node',
      access: { admin: false, projectIds: [1], owner: true, permissionBoundary: null },
      isActive: () => active,
    }, {
      method: WORKFLOW_ADD_NODES_RPC,
      workflowId: 'wf-live',
      nodes: [{ id: 'leaf', task: 'leaf' }],
    });

    active = false;
    releaseLookup();
    await expect(pending).rejects.toThrow('no longer active');
    expect(mutations).toEqual([]);
  });
});
