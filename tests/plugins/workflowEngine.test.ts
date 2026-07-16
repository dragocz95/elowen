import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { registerWorkflow } = await import(resolve(repoRoot, 'plugins/subagent/lib/workflow.mjs')) as {
  registerWorkflow(ctx: unknown, getRun: unknown, helpers: unknown): void;
};

interface Tool { name: string; execute(id: string, p: unknown): Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> }

/** Build a workflow harness: a mock plugin ctx that captures the registered tools + emitted snapshots,
 *  and a controllable fake `run` handler. `run` resolves each node to `done:<task>` unless the task
 *  contains "FAIL" (then it returns an Error), recording the order nodes were launched. */
function harness(opts: { toolPolicyAllow?: string[] } = {}) {
  const tools = new Map<string, Tool>();
  const snapshots: { id: string; status: string; nodes: { id: string; status: string; deps: string[] }[] }[] = [];
  const launched: string[] = [];
  const run = async (_source: unknown, task: string, onEvent: (e: unknown) => void) => {
    launched.push(task);
    onEvent({ type: 'session', sessionId: `s-${task}` });
    onEvent({ type: 'tool', name: 'read_file' });
    onEvent({ type: 'idle', usage: { totalTokens: 100 } });
    return task.includes('FAIL') ? 'Error: boom' : `done:${task}`;
  };
  const ctx = {
    registerTool: (def: Tool) => { tools.set(def.name, def); },
    logger: { info() {}, warn() {} },
    currentSessionId: () => 'brain-parent',
    currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
    currentAccess: () => ({ toolPolicy: opts.toolPolicyAllow ? { allow: opts.toolPolicyAllow } : undefined }),
    currentModel: () => ({ provider: 'p', model: 'm' }),
    workflowEmitter: () => (u: (typeof snapshots)[number]) => { snapshots.push(u); },
    listModels: async () => [],
    toolNames: () => ['read_file', 'write_file', 'run_command'],
  };
  const helpers = {
    resolveDelegateTools: (inheritedAllow: string[] | undefined, readOnly: boolean, requested: string[]) =>
      (readOnly || requested ? { allow: requested ?? ['read_file'] } : { allow: undefined }),
    principalOf: (identity: unknown) => (identity ? 'elowen:1' : null),
    delegateContextChunk: (raw: string) => (raw ? `ctx:${raw}` : undefined),
  };
  registerWorkflow(ctx, () => run, helpers);
  return { tools, snapshots, launched };
}

describe('workflow engine', () => {
  it('runs a linear DAG in dependency order and returns every node result', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('workflow_start')!.execute('t1', {
      nodes: [
        { id: 'a', task: 'a' },
        { id: 'b', task: 'b', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ],
    });
    expect(launched).toEqual(['a', 'b', 'c']);
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: done/);
    expect(text).toContain('done:a');
    expect(text).toContain('done:c');
  });

  it('runs independent nodes that share one dependency in parallel after it', async () => {
    const { tools, launched } = harness();
    await tools.get('workflow_start')!.execute('t2', {
      nodes: [
        { id: 'root', task: 'root' },
        { id: 'x', task: 'x', deps: ['root'] },
        { id: 'y', task: 'y', deps: ['root'] },
      ],
    });
    expect(launched[0]).toBe('root');
    expect(launched.slice(1).sort()).toEqual(['x', 'y']);
  });

  it('marks the workflow errored and skips dependents of a failed node', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('workflow_start')!.execute('t3', {
      nodes: [
        { id: 'a', task: 'a FAIL' },
        { id: 'b', task: 'b', deps: ['a'] },
      ],
    });
    expect(launched).toEqual(['a FAIL']); // b never launches
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/did not run/);
  });

  it('emits a live snapshot stream ending in a terminal status', async () => {
    const { tools, snapshots } = harness();
    await tools.get('workflow_start')!.execute('t4', { nodes: [{ id: 'a', task: 'a' }] });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0]!.status).toBe('running');
    const last = snapshots.at(-1)!;
    expect(last.status).toBe('done');
    expect(last.nodes[0]!.status).toBe('done');
  });

  it('runs nodes added dynamically while the workflow is still running', async () => {
    const tools = new Map<string, Tool>();
    const launched: string[] = [];
    const snapshots: { id: string; status: string }[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` });
      if (task === 'root') await rootGate; // hold the workflow open so we can extend it mid-flight
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => (u: { id: string; status: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['read_file'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: () => 'elowen:1',
      delegateContextChunk: (raw: string) => (raw ? `ctx:${raw}` : undefined),
    });
    const startP = tools.get('workflow_start')!.execute('t6', { title: 'dyn', nodes: [{ id: 'root', task: 'root' }] });
    await new Promise((r) => setTimeout(r, 5)); // let root launch and park on the gate
    const wfId = snapshots[0]!.id; // learn the generated workflow id from the first live snapshot
    const added = await tools.get('workflow_add_nodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']); // leaf ran only after root was released
    expect(res.content[0]!.text).toMatch(/status: done/);
  });

  it('lets a running node self-expand the workflow from its own subagent session', async () => {
    // A delegated node turn always runs as the anonymous `subagent:subagent` principal (no elowenUserId),
    // NOT the origin principal — so authorization for self-expansion must ride on childSessions membership,
    // not a principal match. This drives workflow_add_nodes with exactly that node-child context.
    const tools = new Map<string, Tool>();
    const launched: string[] = [];
    const snapshots: { id: string }[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    // Turn context the harness reports — flipped to the node-child identity for the add call.
    let sessionId = 'brain-parent';
    let identity: { elowenUserId?: number; platform: string; userId: string } = { elowenUserId: 1, platform: 'cli', userId: '1' };
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` }); // registers the node's child session
      if (task === 'root') await rootGate;
      return `done:${task}`;
    };
    const ctx = {
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      logger: { info() {}, warn() {} },
      currentSessionId: () => sessionId,
      currentIdentity: () => identity,
      currentAccess: () => ({ toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      workflowEmitter: () => (u: { id: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['read_file'],
    };
    // Faithful principalOf (mirrors plugins/subagent/index.mjs): elowenUserId → elowen:N, else platform:userId.
    const principalOf = (id: { elowenUserId?: number; platform?: string; userId?: string } | null) =>
      id?.elowenUserId ? `elowen:${id.elowenUserId}` : (id?.platform && id?.userId ? `${id.platform}:${id.userId}` : null);
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf,
      delegateContextChunk: (raw: string) => (raw ? `ctx:${raw}` : undefined),
    });
    const startP = tools.get('workflow_start')!.execute('t7', { nodes: [{ id: 'root', task: 'root' }] });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;
    // Now the RUNNING node calls workflow_add_nodes from its own subagent turn.
    sessionId = 's-root';
    identity = { platform: 'subagent', userId: 'subagent' };
    const added = await tools.get('workflow_add_nodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    // A foreign subagent session (not part of this workflow) must still be refused.
    sessionId = 's-stranger';
    const denied = await tools.get('workflow_add_nodes')!.execute('a2', { workflowId: wfId, nodes: [{ id: 'x', task: 'x' }] });
    expect(denied.content[0]!.text).toMatch(/no running workflow/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']);
    expect(res.content[0]!.text).toMatch(/status: done/);
  });

  it('rejects an invalid DAG without launching anything', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('workflow_start')!.execute('t5', {
      nodes: [{ id: 'a', task: 'a', deps: ['ghost'] }],
    });
    expect(res.content[0]!.text).toMatch(/Error:/);
    expect(launched).toEqual([]);
  });
});
