import { afterAll, describe, it, expect } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflowFilesDir = mkdtempSync(resolve(repoRoot, '.workflow-engine-test-'));
let workflowFileCount = 0;
afterAll(() => { rmSync(workflowFilesDir, { recursive: true, force: true }); });

const rawWorkflowFile = (contents: string): string => {
  const path = resolve(workflowFilesDir, `workflow-${workflowFileCount++}.json`);
  writeFileSync(path, contents);
  return path;
};

const workflowFile = (definition: unknown): string => rawWorkflowFile(JSON.stringify(definition));

const assertTestPathAllowed = (path: string): string => {
  const abs = resolve(path);
  if (abs !== workflowFilesDir && !abs.startsWith(`${workflowFilesDir}${sep}`)) {
    throw new Error(`path not allowed: "${path}" is outside your accessible repositories`);
  }
  return abs;
};
const { registerWorkflow } = await import(resolve(repoRoot, 'plugins/subagent/lib/workflow.mjs')) as {
  registerWorkflow(ctx: unknown, getRun: unknown, helpers: unknown): void;
};
// The REAL chunker, not a double. A pass-through double is what let a wide fan-in ship broken: the engine
// sized its slices against a budget the packaging could never hold, and the only thing that would have
// caught it was the very function the double replaced.
const { delegateContextChunks } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  delegateContextChunks(raw: unknown, totalChars?: number): string[];
};

interface Tool {
  name: string;
  description?: string;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  execute(id: string, p: unknown): Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
}

/** Build a workflow harness: a mock plugin ctx that captures the registered tools + emitted snapshots,
 *  and a controllable fake `run` handler. `run` resolves each node to `done:<task>` unless the task
 *  contains "FAIL" (then it returns an Error), recording the order nodes were launched. */
const TEST_ACCESS = { admin: false, projectIds: [1], owner: true, permissionBoundary: null } as const;

interface WorkflowControl {
  cancelForSession(input: { sessionId: string }): { cancelled: number };
  activeCount(): number;
  addNodesFromSession(input: {
    callerSessionId: string;
    callerAccess: { admin: boolean; projectIds: number[]; owner: boolean; permissionBoundary: null; toolPolicy?: { allow?: string[]; deny?: string[] } };
    workflowId: string;
    nodes: unknown[];
  }): { added: string[] };
  /** The engine's liveness seam: does THIS engine still hold the DAG? Status reads consult it instead of
   *  trusting a durable row whose terminal snapshot may never have landed. */
  isWorkflowLive(input: { workflowId: string }): boolean;
}

/** When set, the harness `run` parks the matching task on this promise and settles it as an aborted
 *  child ("Error: interrupted") once released — the cancel test's stand-in for the host's abort tree. */
let gate: { task: string; promise: Promise<void> } | null = null;

function harness(opts: {
  toolPolicyAllow?: string[]; contextChars?: number;
  /** Park listModels so a test can cancel INSIDE buildNodeAccess, the first startup race. */
  modelsGate?: Promise<void>;
  /** Emit the child's `session` only after the gate — the host's real ordering, where the delegated call is
   *  registered before the first await but the id surfaces much later. This is the second startup race. */
  lateSession?: boolean;
  /** Make the host refuse every stop, the way it does when the call is scoped to a turn that does not own
   *  the child (a node's own turn, after a self-expansion). */
  stopRejects?: boolean;
  /** Report delegated turns as dispatched to a forked runner process. */
  delegatedRemote?: boolean;
  delegatedRpcAvailable?: boolean;
  subagentTypes?: { name: string; description: string }[];
  workflowExpansionRpc?: { addNodes(input: { workflowId: string; nodes: unknown[] }): Promise<{ added: string[] }> };
} = {}) {
  gate = null;
  const tools = new Map<string, Tool>();
  const controls = new Map<string, WorkflowControl>();
  const snapshots: { id: string; toolCallId: string; title?: string; status: string; nodes: { id: string; status: string; deps: string[]; startedAt?: number; result?: string; error?: string }[] }[] = [];
  const launched: string[] = [];
  /** The context chunks each node was actually handed, by task — what the child can see, not what we hoped. */
  const contexts = new Map<string, string[]>();
  // A resume test needs a node that fails its FIRST run and succeeds on retry — real recovery, not a
  // second guaranteed failure. FAIL_ONCE tracks attempts per exact task string.
  const attempts = new Map<string, number>();
  /** Every launch as the host saw it: which channel the node ran in, and the VERBATIM task it received.
   *  A resume is only real if the channel id repeats — that is what puts the retry back in the same session. */
  const runs: { task: string; channelId: string; fullTask: string; sessionIdleMs?: number; toolPolicy?: { allow?: string[]; deny?: string[] }; model?: { provider: string; model: string } }[] = [];
  const run = async (source: { access?: { context?: string[]; sessionIdleMs?: number; toolPolicy?: { allow?: string[]; deny?: string[] }; model?: { provider: string; model: string } }; channelId?: string }, fullTask: string, onEvent: (e: unknown) => void) => {
    // A resumed node is handed its task plus a trailing resume note. Everything keyed by identity here
    // (launch order, session id, FAIL_ONCE attempts) must key on the TASK, or a retry would read as a
    // different node and FAIL_ONCE would fail forever.
    const task = fullTask.split('\n\nNote: an earlier attempt')[0]!;
    launched.push(task);
    runs.push({
      task, channelId: source.channelId ?? '', fullTask,
      ...(source.access?.sessionIdleMs !== undefined ? { sessionIdleMs: source.access.sessionIdleMs } : {}),
      ...(source.access?.toolPolicy !== undefined ? { toolPolicy: source.access.toolPolicy } : {}),
      ...(source.access?.model !== undefined ? { model: source.access.model } : {}),
    });
    contexts.set(task, source.access?.context ?? []);
    if (!opts.lateSession) onEvent({ type: 'session', sessionId: `s-${task}` });
    onEvent({ type: 'tool', name: 'Read' });
    onEvent({ type: 'idle', usage: { totalTokens: 100 } });
    if (gate && task === gate.task) {
      await gate.promise;
      if (opts.lateSession) onEvent({ type: 'session', sessionId: `s-${task}` });
      return 'Error: interrupted';
    }
    if (task.includes('FAIL_ONCE')) {
      const n = (attempts.get(task) ?? 0) + 1;
      attempts.set(task, n);
      if (n === 1) return 'Error: boom (will succeed on retry)';
    } else if (task.includes('FAIL')) return 'Error: boom';
    // A node's own task is capped at 4 000 chars, so a report bigger than that cannot be echoed back from
    // it — `BULK:<n>` asks for a result of n chars instead, the way a real node returns far more than it
    // was asked. It ends in `:CONCLUSION`, so a test can tell whether the END of a report survived.
    const bulk = /BULK:(\d+)/.exec(task);
    return bulk ? `done:${task}:${'x'.repeat(Number(bulk[1]))}:CONCLUSION` : `done:${task}`;
  };
  /** Mutable so a test can call a tool AS one of the workflow's own node sessions. */
  const sessionId = { current: 'brain-parent' };
  /** Mutable so a test can narrow the caller's access boundary between a start and a resume, the way an
   *  operator revoking a project or disabling tools does to a real conversation. */
  const access: {
    current: { admin: boolean; projectIds: number[]; owner: boolean; permissionBoundary: null; toolPolicy?: { allow?: string[]; deny?: string[] }; readOnly?: boolean };
  } = {
    current: { ...TEST_ACCESS, toolPolicy: opts.toolPolicyAllow ? { allow: opts.toolPolicyAllow } : undefined },
  };
  const model = { current: { provider: 'p', model: 'm', thinkingLevel: undefined as string | undefined } };
  /** The node child sessions the engine asked the host to abort — the stand-in for the real abort tree. */
  const stoppedSessions: string[] = [];
  /** What the engine warned about — the only channel it has for a failure it cannot itself recover from. */
  const warnings: string[] = [];
  const ctx = {
    dataDir: () => workflowFilesDir,
    registerTool: (def: Tool) => { tools.set(def.name, def); },
    registerControl: (name: string, control: WorkflowControl) => { controls.set(name, control); },
    stopSubagent: async (id: string) => {
      stoppedSessions.push(id);
      if (opts.stopRejects) throw new Error('unknown sub-agent for this conversation');
      return { stopped: true };
    },
    logger: { info() {}, warn(message: string) { warnings.push(message); } },
    currentSessionId: () => sessionId.current,
    currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
    currentAccess: () => access.current,
    currentModel: () => model.current,
    assertPathAllowed: assertTestPathAllowed,
    workflowEmitter: () => (u: (typeof snapshots)[number]) => { snapshots.push(u); },
    // The gated variant must also RESOLVE the model: returning [] makes buildNodeAccess throw
    // "model is not available" before it ever reaches the fence being tested.
    listModels: async () => {
      if (!opts.modelsGate) return [];
      await opts.modelsGate;
      return [{ provider: 'p', model: 'm' }];
    },
    toolNames: () => ['Read', 'Write', 'Bash'],
    delegateContextChars: () => opts.contextChars ?? undefined,
    delegatedTurnsOutOfProcess: () => opts.delegatedRemote === true,
    delegatedWorkflowExpansionAvailable: () => opts.delegatedRpcAvailable === true,
    workflowExpansionRpc: () => opts.workflowExpansionRpc ?? null,
    subagentTypes: () => opts.subagentTypes ?? [],
  };
  const helpers = {
    resolveDelegateTools: (_inheritedAllow: string[] | undefined, requested: string[] | undefined) =>
      (requested ? { allow: requested } : { allow: undefined }),
    principalOf: (identity: unknown) => (identity ? 'elowen:1' : null),
    delegateContextChunks,
  };
  registerWorkflow(ctx, () => run, helpers);
  /** Everything the node can read, as one string — the chunks are a transport detail, not the content. */
  const contextOf = (task: string) => (contexts.get(task) ?? []).join('\n\n');
  return { tools, controls, snapshots, launched, contexts, contextOf, sessionId, access, model, runs, stoppedSessions, warnings };
}

describe('workflow engine', () => {
  it('loads both supported workflow file shapes and exposes only nodesFile in the start schema', async () => {
    const { tools, launched } = harness();
    const start = tools.get('WorkflowStart');
    expect(start).toBeDefined();
    if (!start) throw new Error('WorkflowStart was not registered');

    expect(start.parameters?.properties).toHaveProperty('nodesFile');
    expect(start.parameters?.properties).not.toHaveProperty('nodes');
    expect(start.parameters?.required).toContain('nodesFile');
    expect(start.description).toContain('use Write');
    // The default directory has to appear VERBATIM: it is resolved from the daemon's data root, so naming
    // it here is the only way the model can learn it. Lose the interpolation and the tool still works
    // while quietly sending every definition back into the user's repository.
    expect(start.description).toContain(resolve(workflowFilesDir, 'workflows'));
    expect(start.parameters?.properties.nodesFile?.description).toContain(resolve(workflowFilesDir, 'workflows'));

    await start.execute('shape-array', { nodesFile: workflowFile([{ id: 'array', task: 'array' }]) });
    await start.execute('shape-object', {
      nodesFile: workflowFile({ title: 'From file', nodes: [{ id: 'object', task: 'object' }] }),
    });
    expect(launched).toEqual(['array', 'object']);
  });

  it('lets explicit start arguments override reusable file options', async () => {
    const { tools, snapshots, contextOf } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const res = await start.execute('precedence', {
      nodesFile: workflowFile({
        title: 'File title',
        context: 'file context',
        background: true,
        nodes: [{ id: 'precedence', task: 'precedence' }],
      }),
      title: 'Argument title',
      context: 'argument context',
      background: false,
    });

    expect(res.content[0]?.text).toMatch(/status: done/);
    expect(snapshots[0]?.title).toBe('Argument title');
    expect(contextOf('precedence')).toContain('argument context');
    expect(contextOf('precedence')).not.toContain('file context');
  });

  it('rejects a workflow file outside the current access boundary', async () => {
    const { tools, launched } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const outside = resolve(repoRoot, '..', 'outside-workflow.json');
    const res = await start.execute('outside', { nodesFile: outside });

    expect(res.content[0]?.text).toBe(`Error: cannot read workflow file "${outside}": path not allowed: "${outside}" is outside your accessible repositories. Create or correct the file inside an accessible repository, then call WorkflowStart again.`);
    expect(launched).toEqual([]);
  });

  it('returns actionable file and node diagnostics without echoing the payload', async () => {
    const { tools, launched } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');

    const missing = resolve(workflowFilesDir, 'missing.json');
    expect((await start.execute('missing', { nodesFile: missing })).content[0]?.text)
      .toMatch(/^Error: cannot read workflow file .* Create or correct the file inside an accessible repository, then call WorkflowStart again\.$/);

    const invalidJson = rawWorkflowFile('{');
    expect((await start.execute('json', { nodesFile: invalidJson })).content[0]?.text)
      .toMatch(/^Error: workflow file .* contains invalid JSON .* Fix the JSON syntax in the file, then call WorkflowStart again\.$/);

    const wrongShape = workflowFile({ title: 'No nodes' });
    expect((await start.execute('shape', { nodesFile: wrongShape })).content[0]?.text)
      .toBe(`Error: workflow file "${wrongShape}" must contain a JSON array of nodes or an object with a "nodes" array. Rewrite the file in one of those two forms, then call WorkflowStart again.`);

    const empty = workflowFile([]);
    expect((await start.execute('empty', { nodesFile: empty })).content[0]?.text)
      .toBe(`Error: workflow file "${empty}": field "nodes" is empty; add at least one node object with required fields "id" and "task".`);

    const nonObject = workflowFile([{ id: 'valid', task: 'valid' }, null]);
    expect((await start.execute('object', { nodesFile: nonObject })).content[0]?.text)
      .toBe(`Error: workflow file "${nonObject}": node 2: must be an object with required fields "id" and "task"; replace this value with a node object.`);

    const missingTask = workflowFile([
      { id: 'research', task: 'research' },
      { id: 'api', task: 'api' },
      { id: 'web-settings' },
    ]);
    expect((await start.execute('task', { nodesFile: missingTask })).content[0]?.text)
      .toBe(`Error: workflow file "${missingTask}": node 3 ("web-settings"): missing required field "task"; add a complete, non-empty string "task" to this node.`);

    // A reusable file carries the run's options too, so a mistyped one has to be named as precisely as a
    // mistyped node — otherwise the only clue is an option that silently did nothing.
    const badOption = workflowFile({ title: 42, nodes: [{ id: 'a', task: 'a' }] });
    expect((await start.execute('option', { nodesFile: badOption })).content[0]?.text)
      .toBe(`Error: workflow file "${badOption}" field "title" must be a string. Fix or remove that field, then call WorkflowStart again.`);
    expect(launched).toEqual([]);
  });

  it('locates the node the validator actually rejected when an id is repeated', async () => {
    // Two entries may carry the same id: the duplicate-id rule only fires once a node normalizes, so a
    // LATER twin that is itself malformed is rejected first and the error names an id that also belongs
    // to a perfectly valid earlier node. Locating the offender by that id points the author at the node
    // that is fine and says it is missing a field it has — worse than no location at all.
    const { tools, launched } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');

    const twinMissingTask = workflowFile([
      { id: 'research', task: 'research' },
      { id: 'research' },
    ]);
    expect((await start.execute('twin-task', { nodesFile: twinMissingTask })).content[0]?.text)
      .toBe(`Error: workflow file "${twinMissingTask}": node 2 ("research"): missing required field "task"; add a complete, non-empty string "task" to this node.`);

    const twinBadDeps = workflowFile([
      { id: 'research', task: 'research' },
      { id: 'research', task: 'again', deps: ['ghost'] },
    ]);
    expect((await start.execute('twin-deps', { nodesFile: twinBadDeps })).content[0]?.text)
      .toBe(`Error: workflow file "${twinBadDeps}": node 2 ("research"): depends on unknown node "ghost"; fix this node in the workflow file.`);
    expect(launched).toEqual([]);
  });

  it('runs a linear DAG in dependency order and returns every node result', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t1', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a' },
        { id: 'b', task: 'b', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ]),
    });
    expect(launched).toEqual(['a', 'b', 'c']);
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: done/);
    expect(text).toContain('done:a');
    expect(text).toContain('done:c');
  });

  it('runs independent nodes that share one dependency in parallel after it', async () => {
    const { tools, launched } = harness();
    await tools.get('WorkflowStart')!.execute('t2', {
      nodesFile: workflowFile([
        { id: 'root', task: 'root' },
        { id: 'x', task: 'x', deps: ['root'] },
        { id: 'y', task: 'y', deps: ['root'] },
      ]),
    });
    expect(launched[0]).toBe('root');
    expect(launched.slice(1).sort()).toEqual(['x', 'y']);
  });

  it('marks the workflow errored and skips dependents of a failed node', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t3', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a FAIL' },
        { id: 'b', task: 'b', deps: ['a'] },
      ]),
    });
    expect(launched).toEqual(['a FAIL']); // b never launches
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/did not run/);
  });

  it('emits a live snapshot stream ending in a terminal status', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t4', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0]!.status).toBe('running');
    const last = snapshots.at(-1)!;
    expect(last.status).toBe('done');
    expect(last.nodes[0]!.status).toBe('done');
  });

  // A dependency edge used to only ORDER the run: the dependent node started with an empty context and had
  // to re-derive, or invent, what its dependencies had already produced. That made the tool's own
  // "gather → analyze → write" promise false, and a real synthesis node reported it could not do its job
  // because the reports it was told it would receive were nowhere in its context.
  it('hands a node the results of the dependencies it waited for', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-deps', {
      nodesFile: workflowFile([
        { id: 'gather', task: 'gather' },
        { id: 'other', task: 'other' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ]),
    });
    const write = contextOf('write');
    expect(write).toContain('done:gather');
    expect(write).toContain('gather'); // attributed to the node it came from
    // Only what it actually depends on — a sibling branch is not its business.
    expect(write).not.toContain('done:other');
    // A root node has nothing to inherit and must not be handed a phantom results block.
    expect(contextOf('gather')).not.toContain('Results from the nodes');
  });

  // A wide fan-in used to lose everything but its first dependency. The slices were cut to fit a budget
  // six times larger than the one context chunk could hold, so the join was clipped from the front and a
  // seven-branch synthesis node received one truncated report and six that were simply absent. It said
  // so in its output, which is the only reason anyone noticed — so the fix has to divide what is really
  // left AND tell the node which results it is not seeing in full.
  it('gives a wide fan-in every dependency, and names the ones it had to truncate', async () => {
    const { tools, contextOf } = harness();
    const branches = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    // Each branch reports far more than its slice can hold, the way a real review section does.
    const longTask = (id: string) => `${id}:${'x'.repeat(3_000)}`;
    await tools.get('WorkflowStart')!.execute('t-fanin', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: longTask(id) })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const synthesis = contextOf('synthesise');
    // Every branch is present and attributed — not just however many fit before the clip.
    for (const id of branches) expect(synthesis).toContain(`## Result from node "${id}"`);
    // And the node is told, by name, what it is reading only part of.
    expect(synthesis).toContain('truncated to fit');
    for (const id of branches) expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // The fan-in the seven-branch test never reached: with dozens of dependencies the divided budget fell
  // below the 400-char floor, which the engine then applied anyway. The blocks that resulted overran the
  // context budget, delegateContextChunks cut the last GROUPS off, and the node ran — and reported — on
  // dependencies it had never been shown. An input it cannot represent must fail the node, not shrink it.
  it('refuses a fan-in it cannot represent instead of running the node on missing dependencies', async () => {
    const { tools, launched, contextOf } = harness({ contextChars: 26_000 });
    const branches = Array.from({ length: 63 }, (_, i) => `n${i}`);
    const res = await tools.get('WorkflowStart')!.execute('t-wide', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: `${id} BULK:600` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/\[synthesis\] ERROR/);
    // Actionable: it names the fan-in and the budget that could not carry it.
    expect(text).toMatch(/63 dependenc/);
    expect(text).toMatch(/26000|26 000/);
    // And it never started on a partial context.
    expect(launched).not.toContain('synthesise');
    expect(contextOf('synthesise')).toBe('');
  });

  // A width the budget CAN represent, with every dependency reporting far more than its slice: the packed
  // context must then sit right under the budget, so each dependency arrives as its own attributed block
  // and none is cut off the end by the chunker. This is where an ESTIMATED block cost overruns.
  it('carries a wide fan-in in full when the budget can hold it, without breaching the scope bounds', async () => {
    const { tools, contexts } = harness({ contextChars: 26_000 });
    const branches = Array.from({ length: 24 }, (_, i) => `n${i}`);
    await tools.get('WorkflowStart')!.execute('t-wide-ok', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const chunks = contexts.get('synthesise') ?? [];
    const joined = chunks.join('\n\n');
    for (const id of branches) expect(joined).toContain(`## Result from node "${id}"`);
    expect(joined).not.toContain('further context block'); // nothing silently cut by the chunker
    expect(chunks.length).toBeLessThanOrEqual(16);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8_000);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThanOrEqual(26_000);
    // Every dependency got the SAME slice. An overrun does not announce itself: the chunker simply shaves
    // the tail of the chunk it no longer has room for, which shows up here as one short final block.
    const sizes = [...receivedPerNode(joined, branches).values()];
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThanOrEqual(400);
  });

  /** How many chars of each dependency's own report actually reached the dependent node. */
  const receivedPerNode = (context: string, ids: string[]): Map<string, number> => {
    const sizes = new Map<string, number>();
    for (const id of ids) {
      const body = context.split(`## Result from node "${id}"\n`)[1] ?? '';
      sizes.set(id, body.split('## Result from node "')[0]!.trim().length);
    }
    return sizes;
  };

  // Five dependencies of 3 000 chars are 15 000 chars in total — far more than one prompt chunk can hold,
  // which is why they used to arrive at ~1 000 chars each (13% of the text). One chunk per dependency
  // carries them whole.
  it('hands a five-way fan-in every dependency in full when the budget allows', async () => {
    const { tools, contextOf } = harness();
    const branches = ['a', 'b', 'c', 'd', 'e'];
    const report = (id: string) => `${id}:${'x'.repeat(3_000)}`;
    await tools.get('WorkflowStart')!.execute('t-five', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: report(id) })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const synthesis = contextOf('synthesise');
    expect(synthesis).not.toContain('[truncated]');
    expect(synthesis).not.toContain('truncated to fit');
    // Every branch's whole report, verbatim — `done:` is what the harness `run` prefixes a result with.
    for (const id of branches) expect(synthesis).toContain(`done:${report(id)}`);
  });

  // The measured regression: five dependencies at the 8 000-char result cap used to reach the dependent
  // node as ~1 093 chars each. The prompt total still cannot carry 40 000 chars, so they ARE truncated —
  // but each must keep a usable share of its report, and the node must be told which ones were cut.
  it('keeps a usable share of each dependency when a five-way fan-in cannot fit whole', async () => {
    const { tools, contextOf } = harness({ contextChars: 26_000 });
    const branches = ['a', 'b', 'c', 'd', 'e'];
    await tools.get('WorkflowStart')!.execute('t-five-big', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const synthesis = contextOf('synthesise');
    for (const [id, size] of receivedPerNode(synthesis, branches)) {
      expect(size, `node ${id}`).toBeGreaterThan(3_000);
    }
    for (const id of branches) expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // A node's report is capped at 8 000 chars before it reaches the parent's summary or any dependent. Over
  // that cap it has to lose its HEAD: a report's conclusion is its last line, and cutting the tail is exactly
  // what destroyed a delegated report's conclusion on delivery.
  it('keeps the END of an over-cap node result, in the summary and in what a dependent reads', async () => {
    const { tools, contextOf } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t-tail', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a BULK:9000' },
        { id: 'b', task: 'b', deps: ['a'] },
      ]),
    });
    const summary = res.content[0]!.text;
    expect(summary).toContain(':CONCLUSION'); // the end survived
    expect(summary).not.toContain('done:a BULK:9000'); // the head is what paid for it
    expect(summary).toMatch(/\[truncated: first \d+ chars dropped, end kept — read it in full with DelegateRead\]/);
    // The dependent reads the same end, marked as cut. It is NOT pointed at DelegateRead: that reads a
    // session's own children, and the node it depends on is a sibling.
    const dependent = contextOf('b');
    expect(dependent).toContain(':CONCLUSION');
    expect(dependent).toContain('[truncated]');
    expect(dependent).not.toContain('DelegateRead');
  });

  // The budget is an operator setting (Settings → Elowen AI → Limits), read live off the plugin context.
  // A workflow that ignored it would silently keep the built-in default whatever the operator chose.
  it('sizes the dependency slices from the operator-configured budget', async () => {
    const branches = ['a', 'b', 'c', 'd', 'e'];
    const nodes = [
      ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
      { id: 'synthesis', task: 'synthesise', deps: branches },
    ];
    const generous = harness({ contextChars: 26_000 });
    await generous.tools.get('WorkflowStart')!.execute('t-generous', { nodesFile: workflowFile(nodes) });
    const tight = harness({ contextChars: 6_000 });
    await tight.tools.get('WorkflowStart')!.execute('t-tight', { nodesFile: workflowFile(nodes) });
    const big = receivedPerNode(generous.contextOf('synthesise'), branches).get('a')!;
    const small = receivedPerNode(tight.contextOf('synthesise'), branches).get('a')!;
    expect(big).toBeGreaterThan(small * 2);
    // Even on the tight budget nothing disappears without the node hearing about it.
    for (const id of branches) expect(tight.contextOf('synthesise')).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // The modal reports which model is burning a node's tokens. `node.model` is only set when the caller
  // named a DIFFERENT one, so reporting that alone left every inheriting node blank — the common case,
  // and the one where "what is actually running?" matters most (it is how a whole review workflow can
  // silently run on the wrong model).
  it('reports the EFFECTIVE model of a node that inherits, not just an explicit override', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-model', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    const node = snapshots.at(-1)!.nodes[0]!;
    expect(node.model).toBe('p/m'); // the parent's model, which the node inherited
  });

  // Regression: qwen3.8-max-preview double-escaped non-ASCII in the title argument, so the parsed string
  // carried a literal backslash-u sequence and the CLI rail showed "Docs update \u2014 write" verbatim.
  it('decodes double-escaped unicode sequences in the model-authored title', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-esc', {
      title: 'Docs \\u2014 p\\u0159epis',
      nodesFile: workflowFile([{ id: 'a', task: 'a' }]),
    });
    expect(snapshots[0]!.title).toBe('Docs — přepis');
  });

  // The dock previews a terminal node's outcome straight from the snapshot, so the emitted nodes must
  // carry result/error (clipped) and startedAt — the engine tracks them internally either way.
  it('carries startedAt plus clipped result and error previews in snapshots', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('t-prev', {
      nodesFile: workflowFile([
        { id: 'good', task: `g${'x'.repeat(600)}` },
        { id: 'bad', task: 'bad FAIL' },
      ]),
    });
    const last = snapshots.at(-1)!;
    const good = last.nodes.find((n) => n.id === 'good')!;
    const bad = last.nodes.find((n) => n.id === 'bad')!;
    expect(good.startedAt).toBeTypeOf('number');
    expect(good.result).toMatch(/^done:gx/);
    expect(good.result!.length).toBeLessThan(560); // 500-char preview + truncation marker, not the full body
    expect(good.result).toMatch(/\[truncated\]$/);
    expect(bad.error).toBe('boom');
  });

  // Every snapshot names the origin's WorkflowStart call: it is the durable anchor that binds the DAG
  // to the parent's transcript row, so the host can persist it and the marker survives a reconnect.
  it('stamps every snapshot with the originating WorkflowStart tool call id', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('call-42', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots.every((s) => s.toolCallId === 'call-42')).toBe(true);
  });

  it('runs nodes added dynamically while the workflow is still running', async () => {
    const tools = new Map<string, Tool>();
    const launched: string[] = [];
    const snapshots: { id: string; toolCallId: string; status: string }[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` });
      if (task === 'root') await rootGate; // hold the workflow open so we can extend it mid-flight
      return `done:${task}`;
    };
    const ctx = {
      dataDir: () => workflowFilesDir,
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ ...TEST_ACCESS, toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      assertPathAllowed: assertTestPathAllowed,
      workflowEmitter: () => (u: { id: string; toolCallId: string; status: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: () => 'elowen:1',
      delegateContextChunks,
    });
    const startP = tools.get('WorkflowStart')!.execute('t6', { title: 'dyn', nodesFile: workflowFile([{ id: 'root', task: 'root' }]) });
    await new Promise((r) => setTimeout(r, 5)); // let root launch and park on the gate
    const wfId = snapshots[0]!.id; // learn the generated workflow id from the first live snapshot
    const added = await tools.get('WorkflowAddNodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']); // leaf ran only after root was released
    expect(res.content[0]!.text).toMatch(/status: done/);
    // An expansion runs under its OWN tool call ('a1'), but the DAG belongs to the origin's
    // WorkflowStart ('t6') — every snapshot must keep naming that row, or the extended workflow would
    // fork a second, phantom marker in the transcript.
    expect(snapshots.every((s) => s.toolCallId === 't6')).toBe(true);
  });

  it('lets a running node self-expand the workflow from its own subagent session', async () => {
    // A delegated node turn always runs as the anonymous `subagent:subagent` principal (no elowenUserId),
    // NOT the origin principal — so authorization for self-expansion must ride on childSessions membership,
    // not a principal match. This drives WorkflowAddNodes with exactly that node-child context.
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
      dataDir: () => workflowFilesDir,
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => sessionId,
      currentIdentity: () => identity,
      currentAccess: () => ({ ...TEST_ACCESS, toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      assertPathAllowed: assertTestPathAllowed,
      workflowEmitter: () => (u: { id: string }) => { snapshots.push(u); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    // Faithful principalOf (mirrors plugins/subagent/index.mjs): elowenUserId → elowen:N, else platform:userId.
    const principalOf = (id: { elowenUserId?: number; platform?: string; userId?: string } | null) =>
      id?.elowenUserId ? `elowen:${id.elowenUserId}` : (id?.platform && id?.userId ? `${id.platform}:${id.userId}` : null);
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf,
      delegateContextChunks,
    });
    const startP = tools.get('WorkflowStart')!.execute('t7', { nodesFile: workflowFile([{ id: 'root', task: 'root' }]) });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;
    // Now the RUNNING node calls WorkflowAddNodes from its own subagent turn.
    sessionId = 's-root';
    identity = { platform: 'subagent', userId: 'subagent' };
    const added = await tools.get('WorkflowAddNodes')!.execute('a1', {
      workflowId: wfId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    });
    expect(added.content[0]!.text).toMatch(/Added 1 node.*leaf/);
    // A foreign subagent session (not part of this workflow) must still be refused.
    sessionId = 's-stranger';
    const denied = await tools.get('WorkflowAddNodes')!.execute('a2', { workflowId: wfId, nodes: [{ id: 'x', task: 'x' }] });
    expect(denied.content[0]!.text).toMatch(/no running workflow/);
    releaseRoot();
    const res = await startP;
    expect(launched).toEqual(['root', 'leaf']);
    expect(res.content[0]!.text).toMatch(/status: done/);
  });

  it('validates RPC additions in the owning engine and keeps snapshots on the origin tool call', async () => {
    const h = harness();
    let release!: () => void;
    gate = { task: 'root', promise: new Promise<void>((resolveGate) => { release = resolveGate; }) };
    const start = h.tools.get('WorkflowStart')!.execute('rpc-origin', {
      nodesFile: workflowFile([{ id: 'root', task: 'root' }]),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const workflowId = h.snapshots[0]!.id;
    const control = h.controls.get('workflow')!;

    expect(() => control.addNodesFromSession({
      callerSessionId: 's-root', callerAccess: { ...TEST_ACCESS }, workflowId,
      nodes: [{ id: 'a', task: 'a', deps: ['b'] }, { id: 'b', task: 'b', deps: ['a'] }],
    })).toThrow(/cycle/i);
    expect(h.launched).toEqual(['root']);

    expect(control.addNodesFromSession({
      callerSessionId: 's-root', callerAccess: { ...TEST_ACCESS }, workflowId,
      nodes: [{ id: 'leaf', task: 'leaf', deps: ['root'] }],
    })).toEqual({ added: ['leaf'] });
    expect(h.snapshots.every((snapshot) => snapshot.toolCallId === 'rpc-origin')).toBe(true);

    release();
    await start;
    expect(() => control.addNodesFromSession({
      callerSessionId: 's-root', callerAccess: { ...TEST_ACCESS }, workflowId, nodes: [{ id: 'late', task: 'late' }],
    })).toThrow(/already finished/);
  });

  it('keeps child-added nodes inside the adding node\'s access boundary', async () => {
    const h = harness();
    let release!: () => void;
    gate = { task: 'root', promise: new Promise<void>((resolveGate) => { release = resolveGate; }) };
    const start = h.tools.get('WorkflowStart')!.execute('bounded-origin', {
      nodesFile: workflowFile([{ id: 'root', task: 'root', tools: ['WorkflowAddNodes'] }]),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    h.sessionId.current = 's-root';
    h.access.current = { ...TEST_ACCESS, toolPolicy: { allow: ['WorkflowAddNodes'] } };
    h.model.current = { provider: 'child-provider', model: 'child-model', thinkingLevel: 'high' };
    const workflowId = h.snapshots[0]!.id;
    const added = await h.tools.get('WorkflowAddNodes')!.execute('bounded-add', {
      workflowId, nodes: [{ id: 'leaf', task: 'leaf' }],
    });
    expect(added.content[0]?.text).toContain('leaf');
    release();
    await start;
    expect(h.runs.find((run) => run.task === 'leaf')).toMatchObject({
      toolPolicy: { allow: ['WorkflowAddNodes'] },
      model: { provider: 'child-provider', model: 'child-model' },
    });
  });

  // The invitation must track reachability: WorkflowAddNodes resolves against the PROCESS-LOCAL engine
  // map, and a node whose turn the host ships to a forked runner lands in that process's own EMPTY
  // instance — its WorkflowAddNodes always answers "no running workflow". Promising expansion there is a
  // lie, so the invite is extended only when delegated turns stay in this process.
  it('invites a full-access node to self-expand only when its turn stays in this process', async () => {
    const local = harness();
    await local.tools.get('WorkflowStart')!.execute('t-invite', { nodesFile: workflowFile([{ id: 'n', task: 'invite-me' }]) });
    expect(local.contextOf('invite-me')).toContain('WorkflowAddNodes');
    // In-process the tool is real, so the node keeps it: no deny is minted.
    expect(local.runs[0]?.toolPolicy?.deny ?? []).not.toContain('WorkflowAddNodes');

    const remote = harness({ delegatedRemote: true });
    await remote.tools.get('WorkflowStart')!.execute('t-remote', { nodesFile: workflowFile([{ id: 'n', task: 'invite-me' }]) });
    expect(remote.contextOf('invite-me')).not.toContain('WorkflowAddNodes');

    const denied = harness();
    denied.access.current = { ...TEST_ACCESS, toolPolicy: { deny: ['Workflow*'] } };
    await denied.tools.get('WorkflowStart')!.execute('t-policy-denied', {
      nodesFile: workflowFile([{ id: 'n', task: 'invite-me' }]),
    });
    expect(denied.contextOf('invite-me')).not.toContain('WorkflowAddNodes');

    const typed = harness({ subagentTypes: [{ name: 'explore', description: 'read-only explorer' }] });
    await typed.tools.get('WorkflowStart')!.execute('t-typed', {
      nodesFile: workflowFile([{ id: 'n', task: 'invite-me', subagent_type: 'explore' }]),
    });
    expect(typed.contextOf('invite-me')).not.toContain('WorkflowAddNodes');
  });

  it('keeps a nested workflow local inside a runner even when the parent RPC bridge exists', async () => {
    let rpcCalls = 0;
    const runner = harness({
      workflowExpansionRpc: {
        addNodes: async () => { rpcCalls += 1; return { added: ['wrong-process'] }; },
      },
    });
    let release!: () => void;
    gate = { task: 'root', promise: new Promise<void>((resolveGate) => { release = resolveGate; }) };
    const start = runner.tools.get('WorkflowStart')!.execute('nested-origin', {
      nodesFile: workflowFile([{ id: 'root', task: 'root' }]),
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    runner.sessionId.current = 's-root';
    const workflowId = runner.snapshots[0]!.id;
    const added = await runner.tools.get('WorkflowAddNodes')!.execute('nested-add', {
      workflowId, nodes: [{ id: 'leaf', task: 'leaf' }],
    });
    expect(added.content[0]?.text).toContain('leaf');
    expect(rpcCalls).toBe(0);
    release();
    await start;
    expect(runner.launched).toEqual(['root', 'leaf']);
  });

  it('routes WorkflowAddNodes through the runner bridge when this engine owns no local DAG', async () => {
    const calls: { workflowId: string; nodes: unknown[] }[] = [];
    const runner = harness({
      workflowExpansionRpc: {
        addNodes: async (input) => { calls.push(input); return { added: ['leaf'] }; },
      },
    });
    const result = await runner.tools.get('WorkflowAddNodes')!.execute('rpc-tool', {
      workflowId: 'wf-daemon', nodes: [{ id: 'leaf', task: 'leaf' }],
    });
    expect(result.content[0]?.text).toBe('Added 1 node(s) to workflow wf-daemon: leaf.');
    expect(calls).toEqual([{
      workflowId: 'wf-daemon', nodes: [{ id: 'leaf', task: 'leaf' }],
    }]);
  });

  // Silence in the briefing is not protection: without the deny a remote node still HOLDS the full
  // toolset, calls WorkflowAddNodes anyway, and gets "no running workflow" from the runner's empty
  // engine. Briefing and tool policy must derive from the same single prediction — and because the deny
  // rides the delegated access, it also survives the dispatcher's fork-failure fallback: a turn predicted
  // remote that ends up in-process is conservatively narrowed, never briefed-one-way-armed-another.
  it('denies WorkflowAddNodes in the tool policy of a node predicted to run remotely', async () => {
    const remote = harness({ delegatedRemote: true });
    await remote.tools.get('WorkflowStart')!.execute('t-remote-deny', { nodesFile: workflowFile([{ id: 'n', task: 'invite-me' }]) });
    expect(remote.runs[0]?.toolPolicy?.deny).toContain('WorkflowAddNodes');

    // An explicitly narrowed node gets the same deny on top of its allow-list: an explicit
    // tools:['WorkflowAddNodes'] must not smuggle the broken tool into a remote turn either.
    const narrowed = harness({ delegatedRemote: true });
    await narrowed.tools.get('WorkflowStart')!.execute('t-remote-narrow', {
      nodesFile: workflowFile([{ id: 'n', task: 'narrow-me', tools: ['Read'] }]),
    });
    expect(narrowed.runs[0]?.toolPolicy).toEqual({ allow: ['Read'], deny: ['WorkflowAddNodes'] });
  });

  // The engine's own answer to "is this DAG still held here?" — what status reads consult instead of
  // trusting a durable row whose terminal snapshot may never have landed (a stale `running` row would
  // otherwise synthesize a phantom anchor until the next daemon restart).
  it('isWorkflowLive answers true only while the engine holds the running DAG', async () => {
    const { tools, controls, snapshots } = harness();
    let releaseRoot!: () => void;
    gate = { task: 'root', promise: new Promise<void>((r) => { releaseRoot = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('t-live', { nodesFile: workflowFile([{ id: 'root', task: 'root' }]) });
    await new Promise((r) => setTimeout(r, 5)); // root launches and parks on the gate
    const wfId = snapshots[0]!.id;
    const control = controls.get('workflow')!;
    expect(control.activeCount()).toBe(1);
    expect(control.isWorkflowLive({ workflowId: wfId })).toBe(true);
    expect(control.isWorkflowLive({ workflowId: 'wf-unknown' })).toBe(false);
    releaseRoot();
    await startP;
    expect(control.activeCount()).toBe(0);
    expect(control.isWorkflowLive({ workflowId: wfId })).toBe(false);
  });

  it('isWorkflowLive turns false the moment a workflow is cancelled', async () => {
    const { tools, controls, snapshots } = harness();
    let releaseRoot!: () => void;
    gate = { task: 'root', promise: new Promise<void>((r) => { releaseRoot = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('t-live-cancel', { nodesFile: workflowFile([{ id: 'root', task: 'root' }]) });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;
    const control = controls.get('workflow')!;
    control.cancelForSession({ sessionId: 'brain-parent' });
    expect(control.isWorkflowLive({ workflowId: wfId })).toBe(false);
    releaseRoot();
    await startP;
  });

  // The Esc-Esc bug: aborting the parent kills the RUNNING node children, but without a cancel the
  // engine relaunches every ready node the moment an aborted one settles — fresh children born after
  // the abort. The control is the host's seam to stop the DAG itself.
  it('cancelForSession halts the DAG: no post-abort launches, terminal status cancelled', async () => {
    const { tools, controls, snapshots, launched } = harness();
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    gate = { task: 'root', promise: rootGate };
    const startP = tools.get('WorkflowStart')!.execute('t-cancel', {
      nodesFile: workflowFile([
        { id: 'root', task: 'root' },
        { id: 'leaf', task: 'leaf', deps: ['root'] },
      ]),
    });
    await new Promise((r) => setTimeout(r, 5)); // root launches and parks on the gate
    // The host aborts: cancel the engine first (as abortLive does), then the running child errors out.
    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' })).toEqual({ cancelled: 1 });
    releaseRoot();
    const res = await startP;
    await new Promise((r) => setTimeout(r, 5)); // let the aborted root settle its final snapshot
    expect(launched).toEqual(['root']); // leaf never launched after the cancel
    const text = res.content[0]!.text;
    expect(text).toMatch(/status: cancelled/);
    expect(text).toMatch(/workflow was cancelled/);
    expect(snapshots.at(-1)!.status).toBe('cancelled');
    // ONE cancellation, one terminal snapshot. The cancel settles the run and publishes it; the wait it
    // releases used to re-stamp finishedAt and publish the very same terminal state again — a duplicate
    // durable write and broadcast, once per running workflow on a plugin reload.
    expect(snapshots.filter((s) => s.status === 'cancelled' && s.nodes.some((n) => n.status === 'running')))
      .toHaveLength(1);
    // A different session's abort cancels nothing here.
    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'someone-else' })).toEqual({ cancelled: 0 });
  });

  // A cancelled summary used to report EVERY unfinished node as "did not run", including the one the
  // cancellation caught mid-work. That node may already have edited files or run commands, and
  // WorkflowResume puts it straight back over that partial state — so the summary has to separate a node
  // that never started from one that started and was stopped.
  it('separates a node interrupted mid-run from one that never started, in a cancelled summary', async () => {
    const { tools, controls } = harness();
    let releaseRoot!: () => void;
    gate = { task: 'root', promise: new Promise<void>((r) => { releaseRoot = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('t-cancel-partial', {
      nodesFile: workflowFile([
        { id: 'root', task: 'root' },
        { id: 'leaf', task: 'leaf', deps: ['root'] },
      ]),
    });
    await new Promise((r) => setTimeout(r, 5)); // root launches and parks on the gate
    controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' });
    releaseRoot();
    const text = (await startP).content[0]!.text;
    await new Promise((r) => setTimeout(r, 5)); // let the aborted root settle

    const rootBlock = text.slice(text.indexOf('[root]'), text.indexOf('[leaf]'));
    expect(rootBlock).toContain('partial changes');
    expect(rootBlock).not.toContain('did not run');
    // leaf never launched, so it genuinely did nothing.
    expect(text.slice(text.indexOf('[leaf]'))).toContain('did not run');
  });

  it('rejects an invalid DAG without launching anything', async () => {
    const { tools, launched } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t5', {
      nodesFile: workflowFile([{ id: 'a', task: 'a', deps: ['ghost'] }]),
    });
    expect(res.content[0]!.text).toMatch(/Error:/);
    expect(launched).toEqual([]);
  });
});

// Regression: pruneWorkflows() only removed workflows finished more than an hour ago, while the start
// limit compared against the WHOLE map. Sixteen quickly-finished workflows locked the tool out for an
// hour with nothing actually in flight, and the error message falsely called them "running".
describe('workflow start limit', () => {
  const MAX_WORKFLOWS = 16;

  /** One node per workflow: `hold` parks on the shared gate until release(); anything else finishes
   *  immediately. `background: true` needs a completion sink to return without blocking on the parked
   *  node, exactly like the production host wiring. */
  function limitHarness() {
    const tools = new Map<string, Tool>();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      onEvent({ type: 'session', sessionId: `s-${task}` });
      if (task === 'hold') { await gate; return 'done:hold'; }
      return `done:${task}`;
    };
    const ctx = {
      dataDir: () => workflowFilesDir,
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ ...TEST_ACCESS, toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      assertPathAllowed: assertTestPathAllowed,
      workflowEmitter: () => () => {},
      workflowCompletionEmitter: () => () => {},
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: () => 'elowen:1',
      delegateContextChunks,
    });
    return { tools, release };
  }

  it('sixteen finished workflows do not block a seventeenth from starting', async () => {
    const { tools } = limitHarness();
    for (let i = 0; i < MAX_WORKFLOWS; i += 1) {
      const res = await tools.get('WorkflowStart')!.execute(`f${i}`, { nodesFile: workflowFile([{ id: 'a', task: `quick${i}` }]) });
      expect(res.content[0]!.text).toMatch(/status: done/);
    }
    const res17 = await tools.get('WorkflowStart')!.execute('f17', { nodesFile: workflowFile([{ id: 'a', task: 'quick17' }]) });
    expect(res17.content[0]!.text).toMatch(/status: done/);
    expect(res17.content[0]!.text).not.toMatch(/too many workflows/);
  });

  it('sixteen genuinely running workflows still block a seventeenth', async () => {
    const { tools, release } = limitHarness();
    const starts = [];
    for (let i = 0; i < MAX_WORKFLOWS; i += 1) {
      starts.push(tools.get('WorkflowStart')!.execute(`r${i}`, { background: true, nodesFile: workflowFile([{ id: 'a', task: 'hold' }]) }));
    }
    await Promise.all(starts); // background handle returns immediately; every node is parked, none finished
    const blocked = await tools.get('WorkflowStart')!.execute('r17', { nodesFile: workflowFile([{ id: 'a', task: 'nope' }]) });
    expect(blocked.content[0]!.text).toMatch(/too many workflows \(16\) are running; wait for one to finish\./);
    release();
    await new Promise((r) => setTimeout(r, 5)); // let the sixteen parked nodes settle before the test ends
  });
});

describe('workflow background + detach', () => {
  interface Completion { id: string; toolCallId: string; title?: string; status: string; result: string }
  interface Ctrl {
    cancelForSession(input: { sessionId: string }): { cancelled: number };
    detachForeground(input: { sessionId: string; principal: string }): { detached: number };
  }
  /** A harness whose single node parks until `release()` and then returns done — so a workflow can be
   *  observed while still running (to detach it) and after it finishes (to see delivery). Captures the
   *  durable completions the engine emits and the registered control. */
  interface Hook { name: string; run(payload: unknown): unknown }
  function bgHarness() {
    const tools = new Map<string, Tool>();
    const controls = new Map<string, Ctrl>();
    const hooks: Hook[] = [];
    const completions: Completion[] = [];
    const snapshots: { id: string; status: string; background?: boolean }[] = [];
    const launched: string[] = [];
    const finished: string[] = [];
    const stoppedSessions: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async (_s: unknown, task: string, onEvent: (e: unknown) => void) => {
      launched.push(task);
      onEvent({ type: 'session', sessionId: `s-${task}` });
      await gate;
      finished.push(task);
      return `done:${task}`;
    };
    const ctx = {
      dataDir: () => workflowFilesDir,
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: (name: string, control: Ctrl) => { controls.set(name, control); },
      registerHook: (hook: Hook) => { hooks.push(hook); },
      stopSubagent: async (id: string) => { stoppedSessions.push(id); return { stopped: true }; },
      logger: { info() {}, warn() {} },
      currentSessionId: () => 'brain-parent',
      currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
      currentAccess: () => ({ ...TEST_ACCESS, toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      assertPathAllowed: assertTestPathAllowed,
      workflowEmitter: () => (u: (typeof snapshots)[number]) => { snapshots.push(u); },
      workflowCompletionEmitter: () => (c: Completion) => { completions.push(c); },
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: (id: { elowenUserId?: number } | null) => (id?.elowenUserId ? `elowen:${id.elowenUserId}` : null),
      delegateContextChunks,
    });
    return { tools, controls, hooks, completions, launched, finished, release, snapshots, stoppedSessions };
  }

  it('background=true returns a handle immediately and delivers the summary when the DAG finishes', async () => {
    const { tools, completions, finished, release } = bgHarness();
    const res = await tools.get('WorkflowStart')!.execute('bg1', { background: true, nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    // Returned while the node is still parked — a handle, not a summary.
    expect(res.details).toMatchObject({ status: 'running' });
    expect(res.content[0]!.text).toMatch(/Started background workflow/);
    expect(completions).toEqual([]);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'bg1', status: 'done' });
    expect(completions[0]!.result).toContain('done:a');
  });

  it('takes background from the file when no argument overrides it', async () => {
    const { tools, completions, release } = bgHarness();
    // The precedence test always overrides the file's value, so on its own it cannot tell a file option that
    // WORKS from one that is read and then dropped. Here the file is the only source: a foreground run would
    // block and return the summary, so the handle is the proof it was honoured.
    const res = await tools.get('WorkflowStart')!.execute('bg-file', {
      nodesFile: workflowFile({ background: true, nodes: [{ id: 'a', task: 'a' }] }),
    });

    expect(res.details).toMatchObject({ status: 'running' });
    expect(res.content[0]!.text).toMatch(/Started background workflow/);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toHaveLength(1);
  });

  it('Ctrl+B detach resolves the parent wait without aborting the running node, then delivers', async () => {
    const { tools, controls, completions, launched, finished, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg1', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5)); // node launches and parks
    expect(launched).toEqual(['a']);
    // Exactly one workflow detaches; the node is NOT aborted — the run keeps going.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 1 });
    expect(finished).toEqual([]);
    const res = await startP; // the parent's blocking wait was resolved by the detach
    expect(res.details).toMatchObject({ status: 'running', detached: true });
    expect(res.content[0]!.text).toMatch(/moved this workflow to the background/);
    expect(completions).toEqual([]); // still running
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']); // the node ran to completion after the detach
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'fg1', status: 'done' });
    expect(completions[0]!.result).toContain('done:a');
  });

  // Ctrl+B tells the user the workflow keeps running, so a later abort in the SAME conversation must not
  // kill it — the host spares a detached delegate's children on this exact seam for the same reason. Any
  // unrelated Esc-Esc used to reach this loop and silently destroy the work.
  it('a parent abort spares a background workflow but still halts a foreground one', async () => {
    const { tools, controls, completions, finished, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('bg-abort', { background: true, nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await startP;
    await new Promise((r) => setTimeout(r, 5));

    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' })).toEqual({ cancelled: 0 });
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(finished).toEqual(['a']); // it ran to completion despite the abort
    expect(completions[0]).toMatchObject({ toolCallId: 'bg-abort', status: 'done' });
  });

  it('publishes `background` on the snapshot so the host can spare its nodes and the CLI can count', async () => {
    const { tools, controls, snapshots, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg-flag', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5));
    expect(snapshots.at(-1)!.background).toBeUndefined(); // a blocking call is not background
    controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' });
    await startP;
    expect(snapshots.at(-1)!.background).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  it('does not re-detach an already-background workflow and ignores a foreign origin', async () => {
    const { tools, controls, release } = bgHarness();
    const startP = tools.get('WorkflowStart')!.execute('fg2', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5));
    // A different session or principal never detaches this workflow.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'someone-else', principal: 'elowen:1' })).toEqual({ detached: 0 });
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:2' })).toEqual({ detached: 0 });
    // The owner detaches it once…
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 1 });
    await startP;
    // …and a second Ctrl+B counts nothing, since it is already background.
    expect(controls.get('workflow')!.detachForeground({ sessionId: 'brain-parent', principal: 'elowen:1' })).toEqual({ detached: 0 });
    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  // A background workflow is spared by every abort of its origin (that is the whole promise of Ctrl+B), so
  // WITHOUT an explicit stop there is no way to end one early at all — it keeps spawning nodes and burning
  // tokens until the DAG runs out. This is that lever.
  it('WorkflowStop ends a background workflow the abort seam deliberately spares', async () => {
    const { tools, controls, completions, snapshots, stoppedSessions, release } = bgHarness();
    await tools.get('WorkflowStart')!.execute('stop1', { background: true, nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;
    // Esc-Esc does not reach it — the exact gap WorkflowStop closes.
    expect(controls.get('workflow')!.cancelForSession({ sessionId: 'brain-parent' })).toEqual({ cancelled: 0 });

    const res = await tools.get('WorkflowStop')!.execute('stop1-stop', { workflowId: wfId });
    await new Promise((r) => setTimeout(r, 5));
    expect(res.details).toMatchObject({ workflowId: wfId, status: 'cancelled', stopped: 1 });
    expect(stoppedSessions).toEqual(['s-a']); // the running node's child session was aborted, not left behind
    expect(snapshots.at(-1)!.status).toBe('cancelled');
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'stop1', status: 'cancelled' });

    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toHaveLength(1); // the aborted node settling later delivers nothing more
  });

  it('WorkflowStop halts the engine, so a node freed by a settling dependency never launches', async () => {
    const { tools, snapshots, launched, release } = bgHarness();
    await tools.get('WorkflowStart')!.execute('stop2', {
      background: true, nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(launched).toEqual(['a']);

    await tools.get('WorkflowStop')!.execute('stop2-stop', { workflowId: snapshots[0]!.id });
    release(); // a settles AFTER the stop — without the engine halt, b would spawn here
    await new Promise((r) => setTimeout(r, 5));
    expect(launched).toEqual(['a']);
  });

  // A plugin reload builds a fresh closure with an empty workflow map, so anything left running here
  // becomes unreachable: no cancel seam, no status/resume/stop, and a durable row stuck on `running`.
  it('a plugin reload settles an unfinished background workflow instead of orphaning it', async () => {
    const { tools, hooks, snapshots, completions, launched, release } = bgHarness();
    await tools.get('WorkflowStart')!.execute('rel1', {
      background: true, nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    await new Promise((r) => setTimeout(r, 5));

    const hook = hooks.find((h) => h.name === 'plugin.reload.before')!;
    expect(hook).toBeDefined();
    hook.run({});
    await new Promise((r) => setTimeout(r, 5));
    expect(snapshots.at(-1)!.status).toBe('cancelled');
    expect(completions[0]).toMatchObject({ toolCallId: 'rel1', status: 'cancelled' });

    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(launched).toEqual(['a']); // nothing spawned into the registry that is being torn down
  });
});

describe('WorkflowStop guards', () => {
  it('refuses an unknown workflow and reports nothing to stop once it has finished', async () => {
    const { tools, snapshots } = harness();
    const unknown = await tools.get('WorkflowStop')!.execute('st0', { workflowId: 'wf-does-not-exist' });
    expect(unknown.content[0]!.text).toMatch(/^Error: no workflow/);

    await tools.get('WorkflowStart')!.execute('st1', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    const done = await tools.get('WorkflowStop')!.execute('st1-stop', { workflowId: snapshots[0]!.id });
    expect(done.content[0]!.text).toMatch(/^Nothing to stop/);
  });

  // Same rule as WorkflowResume: a node is authorized to EXTEND its workflow, never to tear down the run
  // it and its siblings live in.
  it('refuses a stop from one of the workflow\'s own node sessions', async () => {
    const { tools, snapshots, sessionId, stoppedSessions } = harness();
    let releaseA!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { releaseA = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('st2', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5));

    sessionId.current = 's-a'; // the child session running node a
    const res = await tools.get('WorkflowStop')!.execute('st2-stop', { workflowId: snapshots[0]!.id });
    expect(res.content[0]!.text).toMatch(/^Error: no workflow/);
    expect(res.content[0]!.text).toMatch(/only be stopped from the conversation that started it/);
    expect(stoppedSessions).toEqual([]);

    sessionId.current = 'brain-parent';
    releaseA();
    await startP;
  });

  // Stop must leave the run RESUMABLE: a node it aborted mid-work owns a session, so the retry belongs
  // back in that conversation, while a node the stop prevented from launching has nothing to carry over.
  it('a stopped node resumes in its own session, and one that never launched starts clean', async () => {
    const { tools, snapshots, runs, stoppedSessions } = harness();
    let releaseA!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { releaseA = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('sr1', {
      nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;

    const stopped = await tools.get('WorkflowStop')!.execute('sr1-stop', { workflowId: wfId });
    expect(stopped.details).toMatchObject({ status: 'cancelled', stopped: 1 });
    expect(stoppedSessions).toEqual(['s-a']);
    releaseA();
    gate = null; // the retry must not park again
    expect((await startP).content[0]!.text).toMatch(/status: cancelled/);
    await new Promise((r) => setTimeout(r, 5));
    const firstA = runs.find((r) => r.task === 'a')!;

    const resumed = await tools.get('WorkflowResume')!.execute('sr1-resume', { workflowId: wfId });
    expect(resumed.content[0]!.text).toMatch(/status: done/);
    const retryA = runs.filter((r) => r.task === 'a')[1]!;
    expect(retryA.channelId).toBe(firstA.channelId);
    expect(retryA.fullTask).toContain('continue from where you stopped');
    const runB = runs.find((r) => r.task === 'b')!;
    expect(runB.channelId).not.toBe(firstA.channelId);
    expect(runB.fullTask).toBe('b');
  });
});

describe('WorkflowResume', () => {
  it('re-runs only the failed/pending nodes, leaves DONE nodes untouched, and frees their dependents', async () => {
    const { tools, launched, snapshots } = harness();
    const first = await tools.get('WorkflowStart')!.execute('r1', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a' },
        { id: 'b', task: 'b FAIL_ONCE', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ]),
    });
    expect(first.content[0]!.text).toMatch(/status: error/);
    expect(launched).toEqual(['a', 'b FAIL_ONCE']); // c never ran — blocked by b's failure
    const wfId = snapshots[0]!.id;

    const resumed = await tools.get('WorkflowResume')!.execute('r1-resume', { workflowId: wfId });
    const text = resumed.content[0]!.text;
    expect(text).toMatch(/status: done/);
    expect(text).toContain('done:a'); // a's original result, carried forward unchanged
    expect(text).toContain('done:c'); // c finally ran, freed once b succeeded on retry
    // a must NOT be relaunched; b FAIL_ONCE runs exactly twice (its original failure + the retry); c once.
    expect(launched).toEqual(['a', 'b FAIL_ONCE', 'b FAIL_ONCE', 'c']);
  });

  it('puts a failed node back into its own session, and starts a never-launched one clean', async () => {
    const { tools, snapshots, runs } = harness();
    await tools.get('WorkflowStart')!.execute('r5', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a FAIL_ONCE' },
        { id: 'b', task: 'b', deps: ['a'] },
      ]),
    });
    const wfId = snapshots[0]!.id;
    const firstA = runs.find((r) => r.task === 'a FAIL_ONCE')!;

    await tools.get('WorkflowResume')!.execute('r5-resume', { workflowId: wfId });

    // `a` ran and failed: it owns a session, so the retry reuses its channel — same conversation, its own
    // earlier work still visible — and is told to carry on rather than redo everything.
    const retryA = runs.filter((r) => r.task === 'a FAIL_ONCE')[1]!;
    expect(retryA.channelId).toBe(firstA.channelId);
    expect(retryA.fullTask).toContain('continue from where you stopped');

    // `b` never launched (blocked by a's failure), so it has no session to resume into: fresh channel, and
    // no resume note, which would be nonsense in an empty conversation.
    const runB = runs.find((r) => r.task === 'b')!;
    expect(runB.channelId).not.toBe(firstA.channelId);
    expect(runB.fullTask).toBe('b');
  });

  // A resume re-captures the CURRENT access boundary, but a node's child session is pinned to the boundary
  // it was minted under: the host refuses to re-enter a persisted child under a narrowed scope
  // ("delegated access unavailable"). Carrying the channel across therefore killed the resume deep inside
  // the node, after it had already been announced as continuing. It has to start clean instead — and say so.
  it('starts an unfinished node in a fresh channel when the access boundary was narrowed since the start', async () => {
    const { tools, snapshots, runs, access } = harness();
    await tools.get('WorkflowStart')!.execute('r-scope', {
      nodesFile: workflowFile([{ id: 'a', task: 'a FAIL_ONCE' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    const wfId = snapshots[0]!.id;
    const firstA = runs.find((r) => r.task === 'a FAIL_ONCE')!;

    // The operator narrows what this conversation may delegate.
    access.current = { ...TEST_ACCESS, toolPolicy: { allow: ['Read'] } };
    const resumed = await tools.get('WorkflowResume')!.execute('r-scope-resume', { workflowId: wfId });

    const retryA = runs.filter((r) => r.task === 'a FAIL_ONCE')[1]!;
    expect(retryA.channelId).not.toBe(firstA.channelId);
    // Not the resume note: the fresh conversation holds none of the earlier work to continue from, so
    // pointing the node at it would be nonsense. The earlier attempt is not invisible though — whatever it
    // wrote is still on disk, and a retry that assumes an untouched tree redoes half-applied work blind.
    expect(retryA.fullTask).not.toContain('continue from where you stopped');
    expect(retryA.fullTask).toContain('may have left partial changes on disk');
    // `b` never launched, so it has no earlier attempt to be warned about at all.
    expect(runs.find((r) => r.task === 'b')!.fullTask).toBe('b');
    const text = resumed.content[0]!.text;
    expect(text).toMatch(/access boundary has changed/);
    expect(text).toMatch(/status: done/); // the run still completes, it just repeats that node's work
  });

  it('pins the node transcript, without which resuming into its session is silently pointless', async () => {
    // Resuming a node reuses its channel id so it lands back in its own conversation. That only works
    // while the transcript is still THERE: the host rolls a channel over after 30 idle minutes
    // (SESSION_IDLE_ROLLOVER_MS) and archives it under a fresh id, which a resume minutes or hours later
    // would walk straight into. The node opts out by sending sessionIdleMs, which the host maps to
    // idleRolloverMs (src/brain/platforms.ts).
    //
    // This is worth pinning precisely BECAUSE the failure is invisible: the resume note is written to read
    // sensibly in an empty conversation too, so losing the pin would not throw or warn — every resumed node
    // would just quietly start from zero again, which is the bug the whole feature exists to fix.
    const { tools, runs } = harness();
    await tools.get('WorkflowStart')!.execute('r6', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });

    const idle = runs.find((r) => r.task === 'a')!.sessionIdleMs;
    expect(idle).toBeDefined();
    // Far past the host cutoff, and JSON-safe (Infinity would serialize to null on any round-trip).
    expect(idle).toBeGreaterThan(30 * 60 * 1000);
    expect(Number.isFinite(idle)).toBe(true);
  });

  it('does not spawn a node that was cancelled while its access was still being built', async () => {
    // buildNodeAccess awaits listModels, which for an explicit model is a live request. Cancelling inside
    // that window used to leave a stale continuation that still called run() — spawning a child after the
    // stop was announced, with no engine left to reach or abort it. That is the orphan cancellation exists
    // to prevent, so the fence has to sit AFTER the await, not only before it.
    let openModels!: () => void;
    const modelsGate = new Promise<void>((r) => { openModels = r; });
    const { tools, snapshots, launched } = harness({ modelsGate });
    void tools.get('WorkflowStart')!.execute('c1', {
      nodesFile: workflowFile([{ id: 'a', task: 'a', model: 'p/m' }]),
      background: true,
    });
    while (!snapshots.length) await new Promise((r) => setTimeout(r, 0));
    const wfId = snapshots[0]!.id;

    await tools.get('WorkflowStop')!.execute('c1-stop', { workflowId: wfId });
    openModels();
    await new Promise((r) => setTimeout(r, 0));

    expect(launched).toEqual([]); // the node never reached run()
  });

  it('stops a child whose session id only surfaced after the workflow was cancelled', async () => {
    // The host registers the delegated call before its first await but emits `session` only after the lock
    // and the spawn. A child launching in that gap has no id yet, so WorkflowStop's sweep — which can only
    // collect ids it knows — misses it, and the late event used to arrive with nothing left to act on.
    const { tools, snapshots, stoppedSessions } = harness({ lateSession: true });
    let release!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { release = r; }) }; // after harness — it resets gate
    void tools.get('WorkflowStart')!.execute('c2', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]), background: true });
    await new Promise((r) => setTimeout(r, 0));
    const wfId = snapshots[0]!.id;

    await tools.get('WorkflowStop')!.execute('c2-stop', { workflowId: wfId });
    expect(stoppedSessions).toEqual([]); // nothing to sweep yet — the id does not exist
    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(stoppedSessions).toContain('s-a'); // the late id is stopped on arrival instead
  });

  it('reports a late child the host refuses to stop instead of dropping the rejection', async () => {
    // That stop runs on whatever turn is on the stack, and the host scopes a stop to THAT turn's session:
    // after a self-expansion the turn is a node's own, while the child belongs to the origin, so the host
    // refuses it. Unhandled, the rejection escapes into the daemon and the orphan is not even reported.
    const { tools, snapshots, warnings } = harness({ lateSession: true, stopRejects: true });
    let release!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { release = r; }) };
    void tools.get('WorkflowStart')!.execute('c3', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]), background: true });
    await new Promise((r) => setTimeout(r, 0));
    const wfId = snapshots[0]!.id;

    await tools.get('WorkflowStop')!.execute('c3-stop', { workflowId: wfId });
    release();
    await new Promise((r) => setTimeout(r, 5));

    expect(warnings.some((w) => w.includes('s-a') && w.includes('could not be stopped'))).toBe(true);
  });

  it('stops a late child of a self-expansion node, whose turn is not the one that owns it', async () => {
    // The host authorizes a stop against the session on the async-context stack, while every node child is
    // registered under the workflow's ORIGIN. A workflow extended from inside a running node ticks under
    // that NODE's turn, so an ambient stop names a session that does not own the child and is refused —
    // and a child whose id surfaces after the cancellation is exactly the one nothing else can reach, so
    // it keeps running tools and burning tokens unsupervised.
    const turn = new AsyncLocalStorage<{ sessionId: string }>();
    const tools = new Map<string, Tool>();
    const snapshots: { id: string }[] = [];
    const stopped: string[] = [];
    const warnings: string[] = [];
    /** The parent each child was registered under — the stand-in for the host's durable session relation. */
    const parentOfChild = new Map<string, string>();
    let releaseRoot = (): void => {};
    const rootGate = new Promise<void>((r) => { releaseRoot = r; });
    let releaseLeaf = (): void => {};
    const leafGate = new Promise<void>((r) => { releaseLeaf = r; });
    const run = async (
      source: { access?: { parentSessionId?: string } },
      task: string,
      onEvent: (e: { type: string; sessionId: string }) => void,
    ): Promise<string> => {
      parentOfChild.set(`s-${task}`, source.access?.parentSessionId ?? '');
      if (task === 'root') {
        onEvent({ type: 'session', sessionId: 's-root' });
        await rootGate;
        return 'done:root';
      }
      // The leaf's id surfaces only after the gate: the host registers the delegated call before its first
      // await but emits `session` after the spawn, and that window is what WorkflowStop cannot sweep.
      await leafGate;
      onEvent({ type: 'session', sessionId: 's-leaf' });
      return 'done:leaf';
    };
    const ctx = {
      dataDir: () => workflowFilesDir,
      registerTool: (def: Tool) => { tools.set(def.name, def); },
      registerControl: () => {},
      // Faithful to BrainService.stopSubagent: the parent anchor is read from the turn on the stack, never
      // taken from the caller, and a child naming a different parent is simply not addressable from it.
      stopSubagent: async (id: string) => {
        const parent = turn.getStore()?.sessionId;
        if (!parent || parentOfChild.get(id) !== parent) {
          throw new Error('unknown sub-agent for this conversation');
        }
        stopped.push(id);
        return { stopped: true };
      },
      logger: { info() {}, warn(message: string) { warnings.push(message); } },
      currentSessionId: () => turn.getStore()?.sessionId,
      // A delegated node turn runs as the anonymous subagent principal, never the origin's.
      currentIdentity: () => (turn.getStore()?.sessionId === 'brain-parent'
        ? { elowenUserId: 1, platform: 'cli', userId: '1' }
        : { platform: 'subagent', userId: 'subagent' }),
      currentAccess: () => ({ ...TEST_ACCESS, toolPolicy: undefined }),
      currentModel: () => ({ provider: 'p', model: 'm' }),
      assertPathAllowed: assertTestPathAllowed,
      workflowEmitter: () => (u: { id: string }) => { snapshots.push(u); },
      workflowCompletionEmitter: () => () => {},
      listModels: async () => [],
      toolNames: () => ['Read'],
    };
    registerWorkflow(ctx, () => run, {
      resolveDelegateTools: () => ({ allow: undefined }),
      principalOf: (id: { elowenUserId?: number }) => (id.elowenUserId ? `elowen:${id.elowenUserId}` : 'subagent:subagent'),
      delegateContextChunks,
    });
    const tool = (name: string): Tool => {
      const found = tools.get(name);
      if (!found) throw new Error(`${name} was not registered`);
      return found;
    };
    const asTurn = async (sessionId: string, fn: () => Promise<unknown>): Promise<void> => {
      await turn.run({ sessionId }, fn);
    };

    await asTurn('brain-parent', () => tool('WorkflowStart').execute('x1', {
      nodesFile: workflowFile([{ id: 'root', task: 'root' }]), background: true,
    }));
    const wfId = snapshots[0]?.id;
    if (!wfId) throw new Error('the workflow published no snapshot');
    // The RUNNING node extends its own workflow, so the leaf is launched under the node's turn.
    await asTurn('s-root', () => tool('WorkflowAddNodes').execute('x2', {
      workflowId: wfId, nodes: [{ id: 'leaf', task: 'leaf' }],
    }));
    await asTurn('brain-parent', () => tool('WorkflowStop').execute('x3', { workflowId: wfId }));
    expect(stopped).toEqual(['s-root']); // the leaf has no id yet — the sweep cannot see it

    releaseLeaf();
    releaseRoot();
    await new Promise((r) => setTimeout(r, 5));

    expect(stopped).toEqual(['s-root', 's-leaf']);
    expect(warnings).toEqual([]);
  });

  it('reports nothing to resume once every node has already finished', async () => {
    const { tools, snapshots } = harness();
    await tools.get('WorkflowStart')!.execute('r2', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    const wfId = snapshots[0]!.id;

    const res = await tools.get('WorkflowResume')!.execute('r2-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: every node .* already finished/);
  });

  it('refuses to resume a workflow that is still running', async () => {
    const { tools, snapshots } = harness();
    let releaseA!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { releaseA = r; }) };
    const startP = tools.get('WorkflowStart')!.execute('r3', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await new Promise((r) => setTimeout(r, 5));
    const wfId = snapshots[0]!.id;

    const res = await tools.get('WorkflowResume')!.execute('r3-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: workflow .* still running/);
    releaseA();
    await startP;
  });

  // A node session is authorized for WorkflowAddNodes (self-expansion runs under the boundary the child
  // already holds), but resume relaunches nodes under the workflow's PARENT access — so a node given a
  // narrow toolset must not be able to resume siblings and reach work it cannot perform itself.
  it('refuses a resume from one of the workflow\'s own node sessions', async () => {
    const { tools, snapshots, sessionId } = harness();
    await tools.get('WorkflowStart')!.execute('sec1', {
      nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b FAIL', deps: ['a'] }]),
    });
    const wfId = snapshots[0]!.id;

    sessionId.current = 's-a'; // the child session that ran node a
    const res = await tools.get('WorkflowResume')!.execute('sec1-resume', { workflowId: wfId });
    expect(res.content[0]!.text).toMatch(/^Error: no workflow/);
    expect(res.content[0]!.text).toMatch(/only be resumed from the conversation that started it/);
  });

  it('refuses an unknown workflow id, or one belonging to another conversation', async () => {
    const { tools } = harness();
    const res = await tools.get('WorkflowResume')!.execute('r4-resume', { workflowId: 'wf-does-not-exist' });
    expect(res.content[0]!.text).toMatch(/^Error: no workflow/);
  });
});

describe('workflow recovery journal + boot resume', () => {
  const journalPathOf = (wfId: string) => resolve(workflowFilesDir, 'workflows', 'state', `${wfId}.json`);
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5));
    if (!cond()) throw new Error('condition never became true');
  };
  type ResumeControl = {
    resumeInterrupted(input: {
      workflowId: string; parentSessionId: string; toolCallId: string;
      hooks: {
        emit: (u: unknown) => void;
        complete: (c: { id: string; toolCallId: string; status: string; result: string }) => void;
        stopChild: (sessionId: string) => Promise<{ stopped: boolean }>;
      };
    }): Promise<{ resumed: boolean; reason?: string }>;
  };
  const resumeControlOf = (h: ReturnType<typeof harness>): ResumeControl =>
    h.controls.get('workflow') as unknown as ResumeControl;

  it('writes a recovery journal while running and removes it once the workflow is terminal', async () => {
    const h = harness();
    let release!: () => void;
    gate = { task: 'a', promise: new Promise<void>((r) => { release = r; }) };
    const pending = h.tools.get('WorkflowStart')!.execute('j1', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await until(() => h.snapshots.length > 0);
    const wfId = h.snapshots[0]!.id;
    // The journal is on disk while the run can still be interrupted — this file IS the boot-resume input.
    expect(existsSync(journalPathOf(wfId))).toBe(true);
    release();
    await pending;
    // Terminal: the journal's job is over; a leftover file would claim an interrupted run that was not.
    expect(existsSync(journalPathOf(wfId))).toBe(false);
  });

  it('resumes an interrupted workflow from its journal: done nodes kept, the interrupted node back in its own session', async () => {
    // "Crash" harness: node a finishes, node b parks forever on the gate — the engine dies with the
    // process (we simply stop talking to h1) and only the journal survives.
    const h1 = harness();
    gate = { task: 'b', promise: new Promise<void>(() => { /* never released — the crash */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-resume', {
      nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    await until(() => h1.runs.some((r) => r.task === 'b'));
    const wfId = h1.snapshots[0]!.id;
    const crashedChannel = h1.runs.find((r) => r.task === 'b')!.channelId;
    expect(existsSync(journalPathOf(wfId))).toBe(true);

    // "Rebooted" harness: a FRESH engine instance over the same data dir, exactly like a new daemon boot.
    const h2 = harness();
    const emits: { status: string }[] = [];
    const completions: { id: string; toolCallId: string; status: string; result: string }[] = [];
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-parent', toolCallId: 'call-resume',
      hooks: {
        emit: (u) => emits.push(u as { status: string }),
        complete: (c) => completions.push(c),
        stopChild: async () => ({ stopped: true }),
      },
    });
    expect(outcome).toEqual({ resumed: true });
    await until(() => completions.length === 1);

    // Only the interrupted node re-ran — the done node's FULL journaled result fed the summary instead.
    expect(h2.launched).toEqual(['b']);
    // …and it re-ran in its own conversation (same channel id), told to continue rather than start over.
    expect(h2.runs[0]!.channelId).toBe(crashedChannel);
    expect(h2.runs[0]!.fullTask).toContain('an earlier attempt at this node was interrupted');
    const completion = completions[0]!;
    expect(completion).toMatchObject({ id: wfId, toolCallId: 'call-resume', status: 'done' });
    expect(completion.result).toContain('done:a');
    expect(completion.result).toContain('done:b');
    // Fresh snapshots flowed through the hook (they are what keeps the durable DAG row honest)…
    expect(emits.length).toBeGreaterThan(0);
    expect(emits[emits.length - 1]!.status).toBe('done');
    // …and the finished resume disposed of its journal like any terminal workflow.
    await until(() => !existsSync(journalPathOf(wfId)));
  });

  it('journals a PARALLEL node\'s terminal result, so resume does not redo it (no later session event covers it)', async () => {
    // In a sequential DAG the next node's `session` event re-journals everything, masking a missing
    // node-terminal write. With parallel roots nothing fires after `a` completes while `b` hangs — the
    // terminal-write is the only thing that saves a's result across the crash.
    const h1 = harness();
    gate = { task: 'b-par', promise: new Promise<void>(() => { /* never released — the crash */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-par', {
      nodesFile: workflowFile([{ id: 'a', task: 'a-par' }, { id: 'b', task: 'b-par' }]),
    });
    await until(() => h1.snapshots.some((s) => s.nodes.find((n) => n.id === 'a')?.status === 'done'));
    const wfId = h1.snapshots[0]!.id;

    const h2 = harness();
    const completions: { status: string; result: string }[] = [];
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-parent', toolCallId: 'call-par',
      hooks: {
        emit: () => {},
        complete: (c) => completions.push(c),
        stopChild: async () => ({ stopped: true }),
      },
    });
    expect(outcome).toEqual({ resumed: true });
    await until(() => completions.length === 1);
    expect(h2.launched).toEqual(['b-par']); // a-par's journaled result survived; only the hung node re-ran
    expect(completions[0]!.result).toContain('done:a-par');
  });

  it('refuses a claim its journal does not match, so core terminalizes instead', async () => {
    const h1 = harness();
    gate = { task: 'a', promise: new Promise<void>(() => { /* never released */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-mismatch', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await until(() => h1.snapshots.length > 0);
    const wfId = h1.snapshots[0]!.id;

    const h2 = harness();
    const hooks = { emit: () => {}, complete: () => {}, stopChild: async () => ({ stopped: true }) };
    // Wrong origin session: the journal names brain-parent, so this claim must be refused outright —
    // resuming under a different parent would deliver the summary to a conversation that never asked.
    const wrongParent = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-other', toolCallId: 'call-mismatch', hooks,
    });
    expect(wrongParent.resumed).toBe(false);
    // No journal at all (never started here): same honest refusal, with a reason core can log.
    const noJournal = await resumeControlOf(h2).resumeInterrupted({
      workflowId: 'wf-never-existed', parentSessionId: 'brain-parent', toolCallId: 'x', hooks,
    });
    expect(noJournal.resumed).toBe(false);
    expect(noJournal.reason).toBeTruthy();
  });
});
