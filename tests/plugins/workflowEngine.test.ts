import { afterAll, describe, it, expect } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindingRef, resolveDelegatedWorkspace, type WorkspaceAccessCeiling } from '../../src/brain/workspaceScope.js';

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

/** Guest files of a MANAGED project turn, keyed by absolute guest path. They have no host existence at
 *  all — which is the whole point: on a managed turn the host path guard refuses every path, so a
 *  definition the model created with Write is reachable only through the host's guest seam. */
const guestWorkflowFiles = new Map<string, string>();
const rawGuestWorkflowFile = (contents: string): string => {
  const path = `/workspace/workflow-${workflowFileCount++}.json`;
  guestWorkflowFiles.set(path, contents);
  return path;
};
const guestWorkflowFile = (definition: unknown): string => rawGuestWorkflowFile(JSON.stringify(definition));

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
const { dependencyContextChunks } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  dependencyContextChunks(raw: unknown, totalChars?: number): string[];
};

/** The Sandbox ROWS are faked; the resolution rules are not. The harness serves `ctx.resolveWorkspaceScope`
 *  out of the host's own resolver, so a change to how a workspace is admitted is felt here rather than by a
 *  second implementation living in the test. */
const fakeSandboxControl = {
  workspacesFor: ({ userId }: { userId: number }) => (userId === 1
    ? ['ws_root', 'ws_node', 'ws_child'].map((workspaceId) => ({
      workspaceId, projectId: 1, path: `/host/${workspaceId}`, label: workspaceId, branch: 'b', baseRef: 'main',
    }))
    : []),
  resolveWorkspace: ({ accountUserId, workspace }: { accountUserId: number; workspace: { workspaceId: string; projectId: number } }) =>
    ({ accountUserId, ...workspace, path: `/host/${workspace.workspaceId}` }),
} as unknown as Parameters<typeof resolveDelegatedWorkspace>[0];
const testWorkspaceScope = (access: WorkspaceAccessCeiling, workspaceId?: string) => {
  const binding = resolveDelegatedWorkspace(fakeSandboxControl, access, workspaceId);
  return binding ? bindingRef(binding) : undefined;
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
// Not `as const`: every spread of this into a mutable `currentAccess()` shape would otherwise be a type
// error, because `as const` makes `projectIds` a readonly tuple.
const TEST_ACCESS = { admin: false, projectIds: [1], owner: true, permissionBoundary: null, contributionUserId: 1, accountUserId: 1 };

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
  toolPolicyAllow?: string[];
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
  /** The model catalog `ctx.listModels()` serves — a node's own `thinkingLevel` is validated against the
   *  ladder of whichever entry its model resolves to. */
  models?: { provider: string; model: string; reasoningLevels?: string[] }[];
  subagentTypes?: { name: string; description: string }[];
  workflowExpansionRpc?: { addNodes(input: { workflowId: string; nodes: unknown[] }): Promise<{ added: string[] }> };
} = {}) {
  gate = null;
  const tools = new Map<string, Tool>();
  const controls = new Map<string, WorkflowControl>();
  const snapshots: { id: string; toolCallId: string; title?: string; status: string; workspaceRef?: { workspaceId: string; projectId: number }; nodes: { id: string; status: string; deps: string[]; startedAt?: number; result?: string; error?: string; model?: string; thinkingLevel?: string; workspaceRef?: { workspaceId: string; projectId: number } }[] }[] = [];
  const launched: string[] = [];
  /** The context chunks each node was actually handed, by task — what the child can see, not what we hoped. */
  const contexts = new Map<string, string[]>();
  // A resume test needs a node that fails its FIRST run and succeeds on retry — real recovery, not a
  // second guaranteed failure. FAIL_ONCE tracks attempts per exact task string.
  const attempts = new Map<string, number>();
  /** Every launch as the host saw it: which channel the node ran in, and the VERBATIM task it received.
   *  A resume is only real if the channel id repeats — that is what puts the retry back in the same session. */
  const runs: { task: string; channelId: string; fullTask: string; toolPolicy?: { allow?: string[]; deny?: string[] }; model?: { provider: string; model: string }; thinkingLevel?: string; workspaceRef?: { workspaceId: string; projectId: number } }[] = [];
  const run = async (source: { access?: { context?: string[]; toolPolicy?: { allow?: string[]; deny?: string[] }; model?: { provider: string; model: string }; thinkingLevel?: string; workspaceRef?: { workspaceId: string; projectId: number } }; channelId?: string }, fullTask: string, onEvent: (e: unknown) => void) => {
    // A resumed node is handed its task plus a trailing resume note. Everything keyed by identity here
    // (launch order, session id, FAIL_ONCE attempts) must key on the TASK, or a retry would read as a
    // different node and FAIL_ONCE would fail forever.
    const task = fullTask.split('\n\nNote: an earlier attempt')[0]!;
    launched.push(task);
    runs.push({
      task, channelId: source.channelId ?? '', fullTask,
      ...(source.access?.toolPolicy !== undefined ? { toolPolicy: source.access.toolPolicy } : {}),
      ...(source.access?.model !== undefined ? { model: source.access.model } : {}),
      ...(source.access?.thinkingLevel !== undefined ? { thinkingLevel: source.access.thinkingLevel } : {}),
      ...(source.access?.workspaceRef !== undefined ? { workspaceRef: source.access.workspaceRef } : {}),
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
    // A node whose turn ends without saying anything — the shape a model that announces "now writing the
    // file" and stops leaves behind. EMPTY_ONCE does it on the first attempt only, so a resume can prove
    // the node is re-run rather than carried forward as done.
    } else if (task.includes('EMPTY_ONCE')) {
      const n = (attempts.get(task) ?? 0) + 1;
      attempts.set(task, n);
      if (n === 1) return '   ';
    // The task text rides along so a test can drive a REALISTIC failure body (a provider's 400 payload,
    // newlines and all) through the same in-band `Error:` convention the host uses.
    } else if (task.includes('FAIL')) return `Error: boom ${task}`;
    // A node's own task is capped at 4 000 chars, so a report bigger than that cannot be echoed back from
    // it — `BULK:<n>` asks for a result of n chars instead, the way a real node returns far more than it
    // was asked. It ends in `:CONCLUSION`, so a test can tell whether the END of a report survived.
    // `WITH_HANDOVER` makes the node end its answer with the handover section the engine asks dependent
    // nodes' dependencies for — the difference between a handover a node WROTE and one the engine derived.
    // `FENCED_HANDOVER` writes the real section first and then quotes the format in an example fence, the
    // way a node that was just shown the instruction verbatim tends to.
    const handover = task.includes('FENCED_HANDOVER')
      ? `\n\n**Handover:**\nhandover-of:${task}\n\nFor reference the format is:\n\n\`\`\`md\n## Handover\nquoted-example-not-the-handover\n\`\`\``
      : (task.includes('WITH_HANDOVER') ? `\n\n## Handover\nhandover-of:${task}` : '');
    const bulk = /BULK:(\d+)/.exec(task);
    return bulk
      ? `done:${task}:${'x'.repeat(Number(bulk[1]))}:CONCLUSION${handover}`
      : `done:${task}${handover}`;
  };
  /** Mutable so a test can call a tool AS one of the workflow's own node sessions. */
  const sessionId = { current: 'brain-parent' };
  /** Mutable so a test can narrow the caller's access boundary between a start and a resume, the way an
   *  operator revoking a project or disabling tools does to a real conversation. */
  const access: {
    current: { admin: boolean; projectIds: number[]; owner: boolean; permissionBoundary: null; toolPolicy?: { allow?: string[]; deny?: string[] }; readOnly?: boolean; contributionUserId?: number; accountUserId?: number; workspaceRef?: { workspaceId: string; projectId: number }; projectRef?: { kind: 'managed'; projectId: number } };
  } = {
    current: { ...TEST_ACCESS, toolPolicy: opts.toolPolicyAllow ? { allow: opts.toolPolicyAllow } : undefined },
  };
  const model = { current: { provider: 'p', model: 'm', thinkingLevel: undefined as string | undefined } };
  /** The node child sessions the engine asked the host to abort — the stand-in for the real abort tree. */
  const stoppedSessions: string[] = [];
  /** What the engine warned about — the only channel it has for a failure it cannot itself recover from. */
  const warnings: string[] = [];
  /** Every sibling control the engine asked for. `sandbox` must never appear: the real registry refuses it. */
  const controlsAsked: string[] = [];
  /** Paths the engine put through the HOST path guard, and paths it read from the guest. A managed turn
   *  must appear only in the second list: the two routes never mix. */
  const pathGuardCalls: string[] = [];
  const managedReads: string[] = [];
  /** The durable completions a background run handed the host, in delivery order. */
  const completions: { toolCallId: string; status: string; result: string; run?: number }[] = [];
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
    // Exactly what the real registry hands the subagent plugin: NO Sandbox control — it is restricted to the
    // plugins that own process launch (CONTROL_CONSUMERS in src/plugins/registry.ts) — and the host's own
    // workspace resolver instead. A harness that mocked the control is what let the engine ship a resolution
    // path that resolved to nothing in production while every test passed.
    control: (name: string) => { controlsAsked.push(name); return undefined; },
    resolveWorkspaceScope: testWorkspaceScope,
    // The real `assertPathAllowed` refuses EVERY host path on a managed project turn (pathGuard.ts):
    // the guest is a different filesystem, so there is nothing on the host to resolve against.
    assertPathAllowed: (path: string) => {
      pathGuardCalls.push(path);
      if (access.current.projectRef?.kind === 'managed') throw new Error('managed project paths require the guest filesystem provider');
      return assertTestPathAllowed(path);
    },
    // The host's own guest reader, exposed instead of the Sandbox control the plugin may not have. It
    // resolves the project from the HOST turn scope, so the plugin names no project and cannot reach
    // another one.
    readManagedProjectFile: async (path: string) => {
      managedReads.push(path);
      if (access.current.projectRef?.kind !== 'managed') throw new Error('managed project artifacts require a managed project turn');
      const contents = guestWorkflowFiles.get(path);
      if (contents === undefined) throw new Error(`cannot find ${path.split('/').pop()}.`);
      return contents;
    },
    sanitizePathOutput: (text: string) => text,
    workflowEmitter: () => (u: (typeof snapshots)[number]) => { snapshots.push(u); },
    workflowCompletionEmitter: () => (c: { toolCallId: string; status: string; result: string; run?: number }) => { completions.push(c); },
    // The gated variant must also RESOLVE the model: returning [] makes buildNodeAccess throw
    // "model is not available" before it ever reaches the fence being tested.
    listModels: async () => {
      if (!opts.modelsGate) return opts.models ?? [];
      await opts.modelsGate;
      return [{ provider: 'p', model: 'm' }];
    },
    toolNames: () => ['Read', 'Write', 'Bash'],
    delegatedTurnsOutOfProcess: () => opts.delegatedRemote === true,
    delegatedWorkflowExpansionAvailable: () => opts.delegatedRpcAvailable === true,
    workflowExpansionRpc: () => opts.workflowExpansionRpc ?? null,
    subagentTypes: () => opts.subagentTypes ?? [],
  };
  const helpers = {
    resolveDelegateTools: (_inheritedAllow: string[] | undefined, requested: string[] | undefined) =>
      (requested ? { allow: requested } : { allow: undefined }),
    principalOf: (identity: unknown) => (identity ? 'elowen:1' : null),
    dependencyContextChunks,
  };
  registerWorkflow(ctx, () => run, helpers);
  /** Everything the node can read, as one string — the chunks are a transport detail, not the content. */
  const contextOf = (task: string) => (contexts.get(task) ?? []).join('\n\n');
  return { tools, controls, snapshots, launched, contexts, contextOf, sessionId, access, model, runs, stoppedSessions, warnings, controlsAsked, completions, pathGuardCalls, managedReads };
}

describe('workflow engine', () => {
  it('loads both supported workflow file shapes and exposes only nodesFile in the start schema', async () => {
    const { tools, launched } = harness();
    const start = tools.get('WorkflowStart');
    expect(start).toBeDefined();
    if (!start) throw new Error('WorkflowStart was not registered');

    expect(start.parameters?.properties).toHaveProperty('nodesFile');
    expect(start.parameters?.properties).toHaveProperty('workspaceId');
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

  it('applies WorkflowStart.workspaceId as an immutable workspace ceiling', async () => {
    const { tools, runs } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    await start.execute('workspace-default', {
      nodesFile: workflowFile([
        { id: 'default', task: 'default' },
        { id: 'explicit', task: 'explicit', workspaceId: 'ws_root' },
      ]),
      workspaceId: 'ws_root',
    });
    expect(runs.find((run) => run.task === 'default')?.workspaceRef).toEqual({ workspaceId: 'ws_root', projectId: 1 });
    expect(runs.find((run) => run.task === 'explicit')?.workspaceRef).toEqual({ workspaceId: 'ws_root', projectId: 1 });
    const rejected = await start.execute('workspace-sibling', {
      nodesFile: workflowFile([{ id: 'sibling', task: 'sibling', workspaceId: 'ws_node' }]),
      workspaceId: 'ws_root',
    });
    expect(rejected.content[0]?.text).toContain('cannot switch to a sibling workspace');
    const add = tools.get('WorkflowAddNodes');
    expect(add?.parameters?.properties).toHaveProperty('workspaceId');
  });

  /** The account a workspace is resolved against is the host's ONE account resolver (`accountUserId` on
   *  currentAccess): the contribution owner when the turn has one, else the verified identity. A turn
   *  with an identity but no contribution scope — SandboxCreateWorkspace succeeds there — used to make
   *  WorkflowStart throw "Sandbox workspace scope is unavailable" because the plugin read only
   *  `contributionUserId`. */
  it('resolves WorkflowStart.workspaceId through the account resolver when the turn has identity but no contribution scope', async () => {
    const { tools, runs, access } = harness();
    const { contributionUserId: _dropped, ...withoutContribution } = access.current;
    access.current = { ...withoutContribution, accountUserId: 1 };
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const result = await start.execute('workspace-account', {
      nodesFile: workflowFile([{ id: 'node', task: 'account-node' }]),
      workspaceId: 'ws_root',
    });
    expect(result.content[0]?.text).not.toContain('Sandbox workspace scope is unavailable');
    expect(runs.find((run) => run.task === 'account-node')?.workspaceRef).toEqual({ workspaceId: 'ws_root', projectId: 1 });
  });

  /** The engine must never reach for the Sandbox control. That control is restricted to the plugins that own
   *  process launch, so the subagent plugin's `ctx.control('sandbox')` is `undefined` in every real daemon —
   *  which is exactly how a live WorkflowStart failed with "Sandbox workspace scope is unavailable" in the
   *  same conversation that had just created the workspace, while the mocked-control tests all passed. */
  it('assigns a workspace with no Sandbox control of its own, and never asks for one', async () => {
    const { tools, runs, controlsAsked } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const result = await start.execute('workspace-no-control', {
      nodesFile: workflowFile([{ id: 'node', task: 'no-control-node' }]),
      workspaceId: 'ws_root',
    });
    expect(result.content[0]?.text).not.toContain('Sandbox workspace scope is unavailable');
    expect(runs.find((run) => run.task === 'no-control-node')?.workspaceRef).toEqual({ workspaceId: 'ws_root', projectId: 1 });
    expect(controlsAsked).not.toContain('sandbox');
  });

  /** An account-less turn — an unlinked sender in a shared room, instance automation — resolves no account
   *  at all, and a workspace belongs to an account. It has to be refused rather than resolved against
   *  whoever happens to own the Sandbox rows. */
  it('refuses a workspace when the turn names no account', async () => {
    const { tools, launched, access } = harness();
    const { contributionUserId: _c, accountUserId: _a, ...anonymous } = access.current;
    access.current = anonymous;
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const result = await start.execute('workspace-anonymous', {
      nodesFile: workflowFile([{ id: 'node', task: 'anonymous-node' }]),
      workspaceId: 'ws_root',
    });
    expect(result.content[0]?.text).toContain('requires a linked Elowen account');
    expect(launched).toEqual([]);
  });

  /** A node that adds nodes of its own runs under a CAPTURED boundary, not the live turn. That boundary
   *  dropped the account, so a dynamically added node could not name the workspace its own workflow was
   *  already running in. */
  it('lets a node add a node into the workspace the workflow already runs in', async () => {
    const h = harness();
    let release!: () => void;
    gate = { task: 'root', promise: new Promise<void>((resolveGate) => { release = resolveGate; }) };
    const start = h.tools.get('WorkflowStart')!.execute('ws-expand', {
      nodesFile: workflowFile([{ id: 'root', task: 'root' }]),
      workspaceId: 'ws_root',
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    const workflowId = h.snapshots[0]!.id;
    h.sessionId.current = 's-root';
    const added = await h.tools.get('WorkflowAddNodes')!.execute('ws-expand-add', {
      workflowId, nodes: [{ id: 'leaf', task: 'leaf', workspaceId: 'ws_root' }],
    });
    expect(added.content[0]?.text).toContain('leaf');
    release();
    await start;
    expect(h.runs.find((run) => run.task === 'leaf')?.workspaceRef).toEqual({ workspaceId: 'ws_root', projectId: 1 });
  });

  it('lets explicit start arguments override reusable file options', async () => {
    const { tools, snapshots, contextOf } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const res = await start.execute('precedence', {
      nodesFile: workflowFile({
        title: 'File title',
        fork: true,
        background: true,
        nodes: [{ id: 'precedence', task: 'precedence' }],
      }),
      title: 'Argument title',
      fork: false,
      background: false,
    });

    expect(res.content[0]?.text).toMatch(/status: done/);
    expect(snapshots[0]?.title).toBe('Argument title');
    // The argument wins over the file: the node is NOT forked, so it keeps the generic node role prompt.
    expect(contextOf('precedence')).not.toContain('fork-boilerplate');
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

  // The acceptance failure: the tool tells the model to create the definition with Write, Write routes a
  // managed project through the guest provider, and WorkflowStart then read the HOST filesystem — where
  // that file does not exist and the path guard refuses every path anyway. The documented sequence could
  // not complete inside a managed project at all.
  it('reads a managed project definition from the guest and runs the workflow', async () => {
    const { tools, launched, access, pathGuardCalls, managedReads } = harness();
    access.current = { ...TEST_ACCESS, toolPolicy: undefined, projectRef: { kind: 'managed', projectId: 1 } };
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const nodesFile = guestWorkflowFile([{ id: 'guest', task: 'guest-node' }]);

    const res = await start.execute('managed', { nodesFile });

    expect(res.content[0]?.text).toMatch(/status: done/);
    expect(res.content[0]?.text).toContain('done:guest-node');
    expect(launched).toEqual(['guest-node']);
    // The two routes never mix: the host guard is not consulted at all, and the guest read names only
    // the path — the project comes from the host turn scope, so no other project is addressable.
    expect(pathGuardCalls).toEqual([]);
    expect(managedReads).toEqual([nodesFile]);
  });

  it('accepts the object form and start-argument overrides from a guest definition', async () => {
    const { tools, snapshots, access } = harness();
    access.current = { ...TEST_ACCESS, toolPolicy: undefined, projectRef: { kind: 'managed', projectId: 1 } };
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const nodesFile = guestWorkflowFile({ title: 'File title', nodes: [{ id: 'guest', task: 'guest-node' }] });

    const res = await start.execute('managed-object', { nodesFile, title: 'Argument title' });

    expect(res.content[0]?.text).toMatch(/status: done/);
    expect(snapshots[0]?.title).toBe('Argument title');
  });

  it('reports a missing guest definition without falling back to the host filesystem', async () => {
    const { tools, launched, access, pathGuardCalls } = harness();
    access.current = { ...TEST_ACCESS, toolPolicy: undefined, projectRef: { kind: 'managed', projectId: 1 } };
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');

    // A real host path on a managed turn: it exists on disk, and must STILL not be read.
    const hostPath = workflowFile([{ id: 'host', task: 'host-node' }]);
    const res = await start.execute('managed-missing', { nodesFile: hostPath });

    // The remedy names the filesystem the caller is actually on. Pointing a managed caller at "an
    // accessible repository" would send it looking for a host directory it cannot reach.
    expect(res.content[0]?.text).toMatch(/^Error: cannot read workflow file .* Create or correct the file inside the managed project, for example under \/workspace, then call WorkflowStart again\.$/);
    expect(res.content[0]?.text).not.toContain('accessible repository');
    expect(launched).toEqual([]);
    expect(pathGuardCalls).toEqual([]);
  });

  // The host-only guidance sent the acceptance run to a directory that does not exist in a managed
  // project, and told it the directory "already exists" while it did.
  it('offers a guest path in its guidance and never only the host workflow directory', () => {
    const { tools } = harness();
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const nodesFileDoc = (start.parameters?.properties?.nodesFile as { description?: string } | undefined)?.description ?? '';
    const guidance = `${start.description ?? ''} ${nodesFileDoc}`;

    expect(guidance).toContain('/workspace/workflow.json');
    expect(guidance).toMatch(/managed project/i);
    // The "(it already exists)" reassurance stays attached to the host directory it is true of.
    const alreadyExists = guidance.indexOf('it already exists');
    expect(alreadyExists).toBeGreaterThan(-1);
    expect(guidance.slice(0, alreadyExists)).toContain(workflowFilesDir);
  });

  it('reports invalid guest JSON with the same actionable diagnostic as the host route', async () => {
    const { tools, access } = harness();
    access.current = { ...TEST_ACCESS, toolPolicy: undefined, projectRef: { kind: 'managed', projectId: 1 } };
    const start = tools.get('WorkflowStart');
    if (!start) throw new Error('WorkflowStart was not registered');
    const nodesFile = rawGuestWorkflowFile('{');

    expect((await start.execute('managed-json', { nodesFile })).content[0]?.text)
      .toMatch(/^Error: workflow file .* contains invalid JSON .* Fix the JSON syntax in the file, then call WorkflowStart again\.$/);
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
  it('hands a node what the dependencies it waited for handed over', async () => {
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
    expect(write).toContain('## Handover from node "gather"'); // attributed to the node it came from
    // Only what it actually depends on — a sibling branch is not its business.
    expect(write).not.toContain('done:other');
    // A root node has nothing to inherit and must not be handed a phantom handover block.
    expect(contextOf('gather')).not.toContain('Handovers from the nodes');
  });

  // Filip's design: an edge carries a HANDOVER, not a report. A node writes the section itself, and only
  // that section travels — the full result stays with the parent's summary. Passing whole results is what
  // filled a dependent's context with three reports about work it was not doing.
  it('carries only the handover a node wrote, not its result', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-handover', {
      nodesFile: workflowFile([
        { id: 'gather', task: 'gather WITH_HANDOVER BULK:6000' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ]),
    });
    const write = contextOf('write');
    expect(write).toContain('handover-of:gather WITH_HANDOVER BULK:6000');
    // The body of the result — 6 000 chars of it — never travels down the edge.
    expect(write).not.toContain('xxxxxxxxxx');
    expect(write).not.toContain(':CONCLUSION');
    expect(write.length).toBeLessThan(2_000);
  });

  // The instruction quotes the heading verbatim, so a node that also SHOWS the format in a fenced example
  // writes the heading twice. Taking the last match blindly would hand the dependent the example instead of
  // the real section — and the bolded "Handover:" shape a model reaches for must be recognised at all.
  it('reads the real handover, not a quoted example inside a fence', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-fenced', {
      nodesFile: workflowFile([
        { id: 'gather', task: 'gather FENCED_HANDOVER' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ]),
    });
    const write = contextOf('write');
    // The section starts at the node's OWN heading, not at the one inside the example, so the block opens
    // with what the node actually wrote rather than with the quoted sample.
    const block = write.split('## Handover from node "gather"\n')[1] ?? '';
    expect(block.trimStart().startsWith('handover-of:gather FENCED_HANDOVER')).toBe(true);
    expect(write).not.toContain('wrote no handover'); // it wrote one — it must not be read as derived
    expect(write).not.toContain('done:gather'); // …and the result body still did not travel
  });

  // A node that wrote no section still has to hand something down, or its dependent starts blind. The
  // engine derives the END of its result — where a report's conclusion sits — and SAYS that it did, so the
  // dependent does not read a cut-off tail as a written summary.
  it('derives a bounded handover when a node wrote none, and names it as derived', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-derived', {
      nodesFile: workflowFile([
        { id: 'gather', task: 'gather BULK:9000' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ]),
    });
    const write = contextOf('write');
    expect(write).toContain('wrote no handover');
    expect(write).toMatch(/wrote no handover[^\n]*gather/);
    expect(write).toContain(':CONCLUSION'); // the END of the result, not its head
    expect(write).not.toContain('done:gather BULK:9000'); // …and not the head
    // Bounded at the handover cap, well under the 8 000-char result cap.
    const body = write.split('## Handover from node "gather"\n')[1] ?? '';
    expect(body.trim().length).toBeLessThanOrEqual(4_000);
  });

  // Only DIRECT dependencies. A four-node pipeline used to hand the last node every upstream report, so
  // the further down the chain a node sat, the more of its context was about work two steps behind it.
  it('never passes a transitive dependency down the chain', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-transitive', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a WITH_HANDOVER' },
        { id: 'b', task: 'b WITH_HANDOVER', deps: ['a'] },
        { id: 'c', task: 'c', deps: ['b'] },
      ]),
    });
    const c = contextOf('c');
    expect(c).toContain('handover-of:b WITH_HANDOVER');
    expect(c).not.toContain('handover-of:a WITH_HANDOVER');
    expect(c).not.toContain('## Handover from node "a"');
  });

  // A FORK node runs on the origin conversation's system prompt byte for byte, so the host appends NOTHING
  // to it. Handing its dependencies' results over as prompt context therefore lost them without a trace —
  // the node ran with no knowledge of what it waited for, and nothing was truncated, refused or logged.
  // They have to travel in its DIRECTIVE, the one block that already sits after the fork boundary, while
  // the shared prefix stays byte-identical.
  it('gives a fork node its dependency handovers in the directive and appends nothing to the prefix', async () => {
    const { tools, runs, contexts } = harness();
    const res = await tools.get('WorkflowStart')!.execute('t-fork-deps', {
      nodesFile: workflowFile({
        fork: true,
        nodes: [
          { id: 'left', task: 'left WITH_HANDOVER' },
          { id: 'right', task: 'right WITH_HANDOVER' },
          { id: 'join', task: 'join both findings', deps: ['left', 'right'] },
        ],
      }),
    });
    expect(res.content[0]?.text).toMatch(/status: done/);
    // The harness keys a run on the VERBATIM prompt, which for a fork node now carries the handover too.
    const join = runs.find((run) => run.fullTask.startsWith('join both findings'));
    expect(join).toBeDefined();
    // Both dependencies reach it, under the same label the non-fork path uses…
    expect(join?.fullTask).toContain('Results handed over by the nodes this one depends on');
    expect(join?.fullTask).toContain('handover-of:left WITH_HANDOVER');
    expect(join?.fullTask).toContain('handover-of:right WITH_HANDOVER');
    // …and so does the WorkflowAddNodes briefing, which rides in the very same blocks.
    expect(join?.fullTask).toContain('You are node "join" of a running workflow');
    // …while the cached prefix is untouched: a fork node is handed no prompt context at all.
    expect(contexts.get(join!.task)).toEqual([]);
  });

  // A node cannot write a handover it was never asked for, so the instruction has to reach it BEFORE it
  // works — and only when it actually has successors, or a leaf spends its answer on a section nobody reads.
  it('asks a node with successors for a handover and leaves a leaf alone', async () => {
    const { tools, contextOf } = harness();
    await tools.get('WorkflowStart')!.execute('t-instruction', {
      nodesFile: workflowFile([
        { id: 'gather', task: 'gather' },
        { id: 'write', task: 'write', deps: ['gather'] },
      ]),
    });
    const gather = contextOf('gather');
    expect(gather).toContain('## Handover');
    expect(gather).toContain('"write"'); // named, so it can write FOR that node
    expect(contextOf('write')).not.toContain('END your final message');
  });

  // A wide fan-in used to lose everything but its first dependency. The slices were cut to fit a budget
  // six times larger than the one context chunk could hold, so the join was clipped from the front and a
  // seven-branch synthesis node received one truncated report and six that were simply absent. It said
  // so in its output, which is the only reason anyone noticed — so the fix has to divide what is really
  // left AND tell the node which results it is not seeing in full.
  it('gives a wide fan-in every dependency, and names the ones it had to truncate', async () => {
    const { tools, contextOf } = harness();
    const branches = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    // Each branch reports far more than its slice can hold, the way a real review section does.
    const longTask = (id: string) => `${id} BULK:8000`;
    await tools.get('WorkflowStart')!.execute('t-fanin', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: longTask(id) })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const synthesis = contextOf('synthesise');
    // Every branch is present and attributed — not just however many fit before the clip.
    for (const id of branches) expect(synthesis).toContain(`## Handover from node "${id}"`);
    // And the node is told, by name, what it is reading only part of.
    expect(synthesis).toContain('truncated to fit');
    for (const id of branches) expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
  });

  // This used to refuse: the divided budget fell below the 400-char floor, the engine applied it anyway,
  // and the node ran on dependencies it had never been shown. The guard is still there and still fails the
  // node loudly, but it is now DEFENSIVE — the fixed budget carries the widest DAG the engine allows
  // (MAX_NODES) above the floor, so the reachable invariant is that a maximum fan-in arrives whole.
  it('carries the widest fan-in the engine allows without dropping a dependency', async () => {
    const { tools, launched, contextOf } = harness();
    const branches = Array.from({ length: 63 }, (_, i) => `n${i}`);
    const res = await tools.get('WorkflowStart')!.execute('t-wide', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: `${id} BULK:600` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    expect(res.content[0]!.text).toMatch(/status: done/);
    expect(launched).toContain('synthesise');
    const synthesis = contextOf('synthesise');
    for (const id of branches) expect(synthesis).toContain(`## Handover from node "${id}"`);
    // Nothing shaved off the end by the chunker, which is how the original bug presented.
    expect(synthesis).not.toContain('further context block');
  });

  // A width the budget CAN represent, with every dependency reporting far more than its slice: the packed
  // context must then sit right under the budget, so each dependency arrives as its own attributed block
  // and none is cut off the end by the chunker. This is where an ESTIMATED block cost overruns.
  it('carries a wide fan-in in full when the budget can hold it, without breaching the scope bounds', async () => {
    const { tools, contexts } = harness();
    const branches = Array.from({ length: 24 }, (_, i) => `n${i}`);
    await tools.get('WorkflowStart')!.execute('t-wide-ok', {
      nodesFile: workflowFile([
        ...branches.map((id) => ({ id, task: `${id} BULK:8000` })),
        { id: 'synthesis', task: 'synthesise', deps: branches },
      ]),
    });
    const chunks = contexts.get('synthesise') ?? [];
    const joined = chunks.join('\n\n');
    for (const id of branches) expect(joined).toContain(`## Handover from node "${id}"`);
    expect(joined).not.toContain('further context block'); // nothing silently cut by the chunker
    expect(chunks.length).toBeLessThanOrEqual(16);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(8_000);
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThanOrEqual(40_000);
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
      const body = context.split(`## Handover from node "${id}"\n`)[1] ?? '';
      sizes.set(id, body.split('## Handover from node "')[0]!.trim().length);
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
  // node as ~1 093 chars each. Since only a bounded handover travels, five of them fit a generous budget
  // whole — each arriving at the handover cap, none announced as cut. (The tight-budget case, where they
  // genuinely cannot fit, is covered by the operator-budget test below.)
  it('carries five capped handovers whole when the budget can hold them', async () => {
    const { tools, contextOf } = harness();
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
      expect(size, `node ${id}`).toBeLessThanOrEqual(4_000);
    }
    expect(synthesis).not.toContain('truncated to fit');
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

  // The budget is an ENGINE CONSTANT now, not an operator setting: it was a knob only while the same
  // packaging also carried the retired parent-to-child hand-over. What must still hold is that one fixed
  // budget is DIVIDED across the fan-in, and that nothing disappears without the node hearing about it.
  it('divides one fixed budget across the fan-in, and names what it truncated', async () => {
    const run = async (branches: string[], id: string) => {
      const h = harness();
      await h.tools.get('WorkflowStart')!.execute(id, {
        nodesFile: workflowFile([
          ...branches.map((n) => ({ id: n, task: `${n} BULK:20000` })),
          { id: 'synthesis', task: 'synthesise', deps: branches },
        ]),
      });
      return h;
    };
    const wide = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const many = await run(wide, 't-wide-share');
    const synthesis = many.contextOf('synthesise');
    // Every dependency arrives, every one is named as shortened, and the packed whole stays inside the
    // fixed budget — which together is what "divided, not clipped" means.
    for (const id of wide) {
      expect(synthesis).toContain(`## Handover from node "${id}"`);
      expect(synthesis).toMatch(new RegExp(`truncated to fit[^\\n]*${id}`));
    }
    const sizes = [...receivedPerNode(synthesis, wide).values()];
    expect(new Set(sizes).size).toBe(1); // one budget, divided evenly — not a first-come clip
    expect(synthesis.length).toBeLessThanOrEqual(40_000);
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

  /** Per-node reasoning effort. A DAG mixes a mechanical node with one that has to design or debug, so the
   *  level belongs on the node, not on the whole run — and it has to reach the child through the same
   *  access the model does. Mutation: read `parentModel?.thinkingLevel` again in buildNodeAccess and the
   *  declared level is accepted and then ignored. */
  describe('a node\'s own reasoning level', () => {
    const models = [
      { provider: 'p', model: 'm', reasoningLevels: ['low', 'medium', 'high'] },
      { provider: 'p', model: 'plain', reasoningLevels: undefined },
    ];

    it('overrides the level the node would inherit from the workflow origin', async () => {
      const { tools, runs, model } = harness({ models });
      model.current = { provider: 'p', model: 'm', thinkingLevel: 'high' };
      await tools.get('WorkflowStart')!.execute('t-level', {
        nodesFile: workflowFile([
          { id: 'cheap', task: 'cheap', thinkingLevel: 'low' },
          { id: 'inherit', task: 'inherit' },
        ]),
      });
      expect(runs.find((r) => r.task === 'cheap')?.thinkingLevel).toBe('low');
      expect(runs.find((r) => r.task === 'inherit')?.thinkingLevel).toBe('high');
    });

    // Same reason the effective MODEL is reported: an inherited level is invisible on the declaration, and
    // a workflow node was the one child whose reasoning effort no surface showed at all.
    it('reports the effective level on the snapshot, inherited or declared', async () => {
      const { tools, snapshots, model } = harness({ models });
      model.current = { provider: 'p', model: 'm', thinkingLevel: 'high' };
      await tools.get('WorkflowStart')!.execute('t-level-snap', {
        nodesFile: workflowFile([
          { id: 'cheap', task: 'cheap', thinkingLevel: 'low' },
          { id: 'inherit', task: 'inherit' },
        ]),
      });
      const nodes = snapshots.at(-1)!.nodes;
      expect(nodes.find((n) => n.id === 'cheap')?.thinkingLevel).toBe('low');
      expect(nodes.find((n) => n.id === 'inherit')?.thinkingLevel).toBe('high');
    });

    it('fails the node loudly when its model has no such level, naming the ones it has', async () => {
      const { tools, snapshots, launched } = harness({ models });
      await tools.get('WorkflowStart')!.execute('t-level-bad', {
        nodesFile: workflowFile([{ id: 'a', task: 'a', thinkingLevel: 'xhigh' }]),
      });
      const node = snapshots.at(-1)!.nodes[0]!;
      expect(node.status).toBe('error');
      expect(node.error).toContain('thinkingLevel "xhigh" is not available on p/m');
      expect(node.error).toContain('low, medium, high');
      expect(node.error).toContain('node "a"');
      expect(launched).toEqual([]); // refused before the child was ever spawned
    });

    // WorkflowAddNodes shares NODE_SHAPE and the same normalizer, so a dynamically added node has to
    // accept the field too — the declaration is dropped entirely if dag.mjs does not carry it across.
    it('travels through WorkflowAddNodes as well', async () => {
      const h = harness({ models });
      h.model.current = { provider: 'p', model: 'm', thinkingLevel: 'medium' };
      let release!: () => void;
      gate = { task: 'root', promise: new Promise<void>((resolveGate) => { release = resolveGate; }) };
      const started = h.tools.get('WorkflowStart')!.execute('t-level-add', {
        nodesFile: workflowFile([{ id: 'root', task: 'root' }]),
      });
      await new Promise((r) => setTimeout(r, 5));
      const workflowId = h.snapshots[0]!.id;
      const added = await h.tools.get('WorkflowAddNodes')!.execute('t-level-add-1', {
        workflowId,
        nodes: [{ id: 'leaf', task: 'leaf', thinkingLevel: 'high' }],
      });
      expect(added.content[0]!.text).toMatch(/Added 1 node/);
      release();
      await started;
      expect(h.runs.find((r) => r.task === 'leaf')?.thinkingLevel).toBe('high');
      expect(h.tools.get('WorkflowAddNodes')!.parameters?.properties).toHaveProperty('nodes');
    });
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
    expect(bad.error).toContain('boom');
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
      dependencyContextChunks,
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
      dependencyContextChunks,
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

  // A production node died on a provider 400 and WorkflowStatus reported a bare "error": the caller could
  // not tell a bad task from a refused request without digging through the daemon log. The reason is stored
  // either way, so the status line carries a bounded, single-line excerpt of it.
  it('names why a node failed in WorkflowStatus, bounded and on one line', async () => {
    const { tools, snapshots } = harness();
    const longFailure = `400 invalid_request_error ${'y'.repeat(600)}\nsecond line`;
    await tools.get('WorkflowStart')!.execute('t-status-error', {
      nodesFile: workflowFile([
        { id: 'ok', task: 'ok' },
        { id: 'bad', task: `bad FAIL ${longFailure}` },
      ]),
    });
    const status = await tools.get('WorkflowStatus')!.execute('t-status-error-read', { workflowId: snapshots[0]!.id });
    const text = status.content[0]!.text;
    const badLine = text.split('\n').find((line) => line.startsWith('- [bad]'))!;
    expect(badLine).toContain('error');
    expect(badLine).toContain('boom'); // the stored reason, not just the status word
    expect(badLine.length).toBeLessThan(500); // bounded: a wide DAG stays readable
    // A node that succeeded says nothing about its output here — this is still a status view.
    expect(text.split('\n').find((line) => line.startsWith('- [ok]'))).not.toContain('done:ok');
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
      dependencyContextChunks,
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
      dependencyContextChunks,
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
  // Seen in production: a node announced "now writing the report" and ended its turn with nothing, the
  // workflow reported it DONE with "(the node returned nothing)", its dependent got an empty handover, and
  // nothing flagged the run as failed — so nobody resumed it.
  it('fails a node that ends its turn without a result, and a resume re-runs it', async () => {
    const { tools, launched, snapshots } = harness();
    const first = await tools.get('WorkflowStart')!.execute('empty1', {
      nodesFile: workflowFile([{ id: 'a', task: 'a EMPTY_ONCE' }, { id: 'b', task: 'b', deps: ['a'] }]),
    });
    const text = first.content[0]!.text;
    expect(text).toMatch(/status: error/);
    expect(text).toMatch(/\[a\] ERROR\nError: the node ended its turn without returning a result/);
    expect(text).toMatch(/\[b\] PENDING \(after a\)\n\(did not run — a dependency failed\)/);

    const resumed = await tools.get('WorkflowResume')!.execute('empty1-resume', { workflowId: snapshots[0]!.id });
    expect(resumed.content[0]!.text).toMatch(/status: done/);
    expect(launched).toEqual(['a EMPTY_ONCE', 'a EMPTY_ONCE', 'b']);
  });

  // The first run's summary was delivered and acknowledged under the workflow id. A resumed run's
  // summary is a NEW result the parent has not heard, so it must be numbered as its own run — the host
  // dedupes by result id, and an unnumbered second completion would be dropped as a duplicate.
  it('numbers the completion of each resumed background run so the host delivers it, not drops it', async () => {
    const { tools, snapshots, completions } = harness();
    await tools.get('WorkflowStart')!.execute('bg-resume', {
      nodesFile: workflowFile([{ id: 'a', task: 'a FAIL_ONCE' }]), background: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ toolCallId: 'bg-resume', status: 'error', run: 0 });

    await tools.get('WorkflowResume')!.execute('bg-resume-2', { workflowId: snapshots[0]!.id });
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toHaveLength(2);
    expect(completions[1]).toMatchObject({ toolCallId: 'bg-resume', status: 'done', run: 1 });
    expect(completions[1]!.result).toContain('done:a');
  });

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
      dependencyContextChunks,
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
      trustedWorkspaceRef?: { workspaceId: string; projectId: number };
      trustedNodeWorkspaceRefs?: Record<string, { workspaceId: string; projectId: number }>;
      hooks: {
        emit: (u: unknown) => void;
        complete: (c: { id: string; toolCallId: string; status: string; result: string }) => void;
        stopChild: (sessionId: string) => Promise<{ stopped: boolean }>;
        continueNode?: (sessionId: string, onEvent?: (e: { type: string; name?: string; sessionId?: string }) => void)
          => Promise<{ outcome: 'answered' | 'continued'; reply: string } | { outcome: 'empty' }>;
        validateBoundary: (access: unknown) => { ok: boolean; reason?: string };
      };
    }): Promise<{ resumed: boolean; reason?: string }>;
  };
  /** Crash a two-node chain on node b (a done, b parked forever) and return what a reboot needs. */
  const crashOnB = async () => {
    const h1 = harness();
    gate = { task: 'b', promise: new Promise<void>(() => { /* never released — the crash */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-resume', {
      nodesFile: workflowFile([{ id: 'a', task: 'a' }, { id: 'b', task: 'b', deps: ['a'] }, { id: 'c', task: 'c', deps: ['b'] }]),
    });
    await until(() => h1.runs.some((r) => r.task === 'b'));
    return { wfId: h1.snapshots[0]!.id, crashedChannel: h1.runs.find((r) => r.task === 'b')!.channelId };
  };
  const rebootWith = async (wfId: string, continueNode: NonNullable<Parameters<ResumeControl['resumeInterrupted']>[0]['hooks']['continueNode']>) => {
    const h2 = harness();
    const completions: { id: string; toolCallId: string; status: string; result: string }[] = [];
    const emits: { nodes: { id: string; status: string; sessionId: string }[] }[] = [];
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-parent', toolCallId: 'call-resume',
      hooks: { emit: (u) => emits.push(u as typeof emits[number]), complete: (c) => completions.push(c), stopChild: async () => ({ stopped: true }), continueNode, validateBoundary: () => ({ ok: true }) },
    });
    expect(outcome).toEqual({ resumed: true });
    await until(() => completions.length === 1);
    return { h2, completion: completions[0]!, emits };
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
        validateBoundary: () => ({ ok: true }),
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

  it('boot resume CONTINUES a node that kept its session instead of prompting it with its task again', async () => {
    // The production shape: the node's child was cut mid-turn by the pause. The host continues that turn
    // silently (over `[interrupted]` tool results) and its answer is the node's result; the dependent
    // then runs as usual, and the summary carries both. The node's task is never sent a second time.
    const { wfId, crashedChannel } = await crashOnB();
    const continued: { sessionId: string; events: string[] }[] = [];
    const { h2, completion, emits } = await rebootWith(wfId, async (sessionId, onEvent) => {
      const events: string[] = [];
      continued.push({ sessionId, events });
      onEvent?.({ type: 'session', sessionId });
      onEvent?.({ type: 'tool', name: 'Bash' });
      return { outcome: 'continued', reply: 'b finished after the restart' };
    });
    expect(continued.map((c) => c.sessionId)).toEqual(['s-b']); // the journaled child, once
    expect(h2.launched).toEqual(['c']); // b was NOT re-prompted; only its dependent ran through the prompt path
    expect(h2.runs.map((r) => r.task)).toEqual(['c']);
    expect(completion.status).toBe('done');
    expect(completion.result).toContain('b finished after the restart');
    expect(completion.result).toContain('done:c');
    // The continued node keeps its channel/session so status readers still find its conversation.
    expect(emits.at(-1)!.nodes.find((n) => n.id === 'b')).toMatchObject({ status: 'done', sessionId: 's-b' });
    expect(crashedChannel).toContain(wfId);
  });

  it('boot resume takes a node\'s answer straight from its transcript when the child had already answered', async () => {
    const { wfId } = await crashOnB();
    const { h2, completion } = await rebootWith(wfId, async () => ({ outcome: 'answered', reply: 'b had answered before the pause' }));
    expect(h2.launched).toEqual(['c']);
    expect(completion.result).toContain('b had answered before the pause');
  });

  it('boot resume falls back to the resume prompt when the child has nothing to continue, and after a failed continuation', async () => {
    const { wfId, crashedChannel } = await crashOnB();
    const { h2 } = await rebootWith(wfId, async () => ({ outcome: 'empty' }));
    expect(h2.launched).toEqual(['b', 'c']);
    expect(h2.runs[0]!.channelId).toBe(crashedChannel);
    expect(h2.runs[0]!.fullTask).toContain('an earlier attempt at this node was interrupted');

    const second = await crashOnB();
    const { h2: h3 } = await rebootWith(second.wfId, async () => { throw new Error('child vanished'); });
    expect(h3.launched).toEqual(['b', 'c']);
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
        validateBoundary: () => ({ ok: true }),
      },
    });
    expect(outcome).toEqual({ resumed: true });
    await until(() => completions.length === 1);
    expect(h2.launched).toEqual(['b-par']); // a-par's journaled result survived; only the hung node re-ran
    expect(completions[0]!.result).toContain('done:a-par');
  });

  // A journal written before handovers existed carries a done node's result and no handover. The dependent
  // that resumes on top of it must not start with an EMPTY dependency block — that is worse than the tail it
  // would have had, because the node then silently re-derives or invents what its dependency established.
  it('derives a handover for a done node journaled without one', async () => {
    const h1 = harness();
    gate = { task: 'b-old', promise: new Promise<void>(() => { /* never released — the crash */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-old-journal', {
      nodesFile: workflowFile([
        { id: 'a', task: 'a-old' },
        { id: 'b', task: 'b-old' },
        // Depends on the hung node too, so it is still unrun when the crash freezes the journal.
        { id: 'c', task: 'c-old', deps: ['a', 'b'] },
      ]),
    });
    await until(() => h1.snapshots.some((s) => s.nodes.find((n) => n.id === 'a')?.status === 'done'));
    const wfId = h1.snapshots[0]!.id;

    // Rewrite the journal into the older shape: the done node keeps its result and loses its handover.
    const path = journalPathOf(wfId);
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { state: [string, Record<string, unknown>][] };
    const doneEntry = journal.state.find(([id]) => id === 'a')!;
    expect(doneEntry[1].handover).toBeDefined();
    delete doneEntry[1].handover;
    writeFileSync(path, JSON.stringify(journal));

    const h2 = harness();
    const completions: { status: string }[] = [];
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-parent', toolCallId: 'call-old-journal',
      hooks: {
        emit: () => {}, complete: (c) => completions.push(c),
        stopChild: async () => ({ stopped: true }), validateBoundary: () => ({ ok: true }),
      },
    });
    expect(outcome).toEqual({ resumed: true });
    await until(() => completions.length === 1);
    const dependent = h2.contextOf('c-old');
    expect(dependent).toContain('## Handover from node "a"');
    expect(dependent).toContain('done:a-old'); // the journaled result, derived into a bounded handover
    expect(dependent).toContain('wrote no handover');
  });

  it('treats the durable workflow snapshot as the workspace authority and rejects a tampered journal', async () => {
    const h1 = harness();
    h1.access.current.workspaceRef = { workspaceId: 'ws-trusted', projectId: 1 };
    gate = { task: 'a-anchor', promise: new Promise<void>(() => { /* interrupted */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-anchor', { nodesFile: workflowFile([{ id: 'a', task: 'a-anchor' }]) });
    await until(() => h1.snapshots.length > 0);
    const trusted = h1.snapshots[0]!;
    expect(trusted.workspaceRef).toEqual({ workspaceId: 'ws-trusted', projectId: 1 });
    expect(trusted.nodes[0]!.workspaceRef).toEqual({ workspaceId: 'ws-trusted', projectId: 1 });

    const path = journalPathOf(trusted.id);
    const journal = JSON.parse(readFileSync(path, 'utf8')) as { workspaceRef: { workspaceId: string }; nodes: { workspaceRef?: { workspaceId: string } }[] };
    journal.workspaceRef.workspaceId = 'ws-sibling';
    journal.nodes[0]!.workspaceRef!.workspaceId = 'ws-sibling';
    writeFileSync(path, JSON.stringify(journal));

    const h2 = harness();
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: trusted.id, parentSessionId: 'brain-parent', toolCallId: 'call-anchor',
      trustedWorkspaceRef: trusted.workspaceRef,
      trustedNodeWorkspaceRefs: { a: trusted.nodes[0]!.workspaceRef! },
      hooks: {
        emit: () => {}, complete: () => { throw new Error('must not complete a refused resume'); },
        stopChild: async () => ({ stopped: true }),
        validateBoundary: () => { throw new Error('journal workspace must be rejected before access validation'); },
      },
    });
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toContain('trusted workflow snapshot');
    expect(h2.launched).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  it('refuses to resume when core rejects a journaled boundary, and runs nothing (D3)', async () => {
    // The journal is an agent-writable file: a widened (or merely stale) boundary must never be replayed
    // as authority. Core's validateBoundary hook is the arbiter; the first refusal kills the resume
    // BEFORE any node launches, and the dead journal is disposed of.
    const h1 = harness();
    gate = { task: 'a-sec', promise: new Promise<void>(() => { /* never released — the crash */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-sec', { nodesFile: workflowFile([{ id: 'a', task: 'a-sec' }]) });
    await until(() => h1.snapshots.length > 0);
    const wfId = h1.snapshots[0]!.id;
    expect(existsSync(journalPathOf(wfId))).toBe(true);

    const h2 = harness();
    const validated: unknown[] = [];
    const outcome = await resumeControlOf(h2).resumeInterrupted({
      workflowId: wfId, parentSessionId: 'brain-parent', toolCallId: 'call-sec',
      hooks: {
        emit: () => {},
        complete: () => { throw new Error('must not complete a refused resume'); },
        stopChild: async () => ({ stopped: true }),
        validateBoundary: (access) => { validated.push(access); return { ok: false, reason: 'admin authority revoked since the crash' }; },
      },
    });
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toContain('admin authority revoked');
    expect(validated.length).toBeGreaterThan(0); // the journaled parentAccess actually went through the check
    expect(h2.launched).toEqual([]); // nothing ran under the rejected boundary
    expect(existsSync(journalPathOf(wfId))).toBe(false);
  });

  it('refuses a claim its journal does not match, so core terminalizes instead', async () => {
    const h1 = harness();
    gate = { task: 'a', promise: new Promise<void>(() => { /* never released */ }) };
    void h1.tools.get('WorkflowStart')!.execute('call-mismatch', { nodesFile: workflowFile([{ id: 'a', task: 'a' }]) });
    await until(() => h1.snapshots.length > 0);
    const wfId = h1.snapshots[0]!.id;

    const h2 = harness();
    const hooks = { emit: () => {}, complete: () => {}, stopChild: async () => ({ stopped: true }), validateBoundary: () => ({ ok: true }) };
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
