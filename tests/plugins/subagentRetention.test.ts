import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

// `resultRetentionMs` is ONE knob over two registries that used to hold their own hour-long constant:
// delegate's background jobs and the workflow engine's DAGs. Both are the same promise to the parent —
// "your result is still collectable" — so these tests drive the real expiry on each side, not the clamp.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = { info() {}, warn() {}, error() {} };
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

interface ToolResult { content: { text: string }[]; details?: Record<string, unknown> }
interface Executable { execute(id: string, p: unknown): Promise<ToolResult> }

/** Only Date is faked: the plugin's retention arithmetic reads Date.now(), while the delegation itself
 *  rides real promises and real setImmediate — faking those would deadlock the child hand-off. */
const advance = (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
const flush = () => new Promise<void>((r) => { setImmediate(r); });

describe('subagent result retention — background jobs', () => {
  let dataRoot: string;
  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-retention-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-04T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = (config?: Record<string, unknown>) => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot, logger: log,
    config: config ? { subagent: config } : undefined,
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

  /** Start and settle ONE background delegation, returning its job id once the job is terminal. */
  const finishedJob = async (reg: PluginRegistry): Promise<string> => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-retention' });
      return 'the child conclusion';
    });
    const res = await runWithPolicy(
      adminPolicy,
      () => tool(reg, 'Delegate').execute('call-1', { task: 'a retained task', background: true }),
      { identity: owner, sessionId: 'brain-1', emitSubagent: () => {}, emitSubagentCompletion: () => {} },
    );
    const jobId = res.details?.jobId;
    if (typeof jobId !== 'string') throw new Error('Delegate returned no jobId');
    for (let i = 0; i < 50 && (await status(reg, jobId)).includes('RUNNING'); i += 1) await flush();
    return jobId;
  };

  const status = (reg: PluginRegistry, jobId: string): Promise<string> => runWithPolicy(
    adminPolicy,
    () => tool(reg, 'DelegateStatus').execute('call-status', { id: jobId }),
    { identity: owner, sessionId: 'brain-1' },
  ).then((r) => r.content[0]?.text ?? '');

  it('forgets a finished job once the CONFIGURED retention has passed', async () => {
    const reg = await load({ resultRetentionMs: 600_000 }); // 10 min — the floor
    const jobId = await finishedJob(reg);
    expect(await status(reg, jobId)).toContain(`Delegation job ${jobId}: DONE`);

    advance(9 * 60_000);
    expect(await status(reg, jobId)).toContain(`Delegation job ${jobId}: DONE`); // still inside the window

    advance(2 * 60_000); // 11 min total — past the configured 10
    expect(await status(reg, jobId)).toContain(`no background delegation ${jobId}`);
  });

  it('keeps the same job for the full hour when nothing is configured', async () => {
    const reg = await load();
    const jobId = await finishedJob(reg);

    advance(11 * 60_000); // past the shortest settable retention, well inside the 1 h default
    expect(await status(reg, jobId)).toContain(`Delegation job ${jobId}: DONE`);

    advance(50 * 60_000); // 61 min total — past the default
    expect(await status(reg, jobId)).toContain(`no background delegation ${jobId}`);
  });

  it('clamps a value below the floor up to 10 minutes rather than expiring results instantly', async () => {
    const reg = await load({ resultRetentionMs: 1_000 });
    const jobId = await finishedJob(reg);

    advance(5 * 60_000); // way past the 1 s asked for, still inside the enforced floor
    expect(await status(reg, jobId)).toContain(`Delegation job ${jobId}: DONE`);
  });
});

// ── Workflows ────────────────────────────────────────────────────────────────
// The engine registers against a plain plugin ctx, so it is driven directly here (like workflowEngine's
// own suite) rather than through the loader — what matters is that it reads the SAME resolved knob.

interface WorkflowTool {
  name: string;
  execute(id: string, p: unknown): Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
}

const { registerWorkflow } = await import(resolve(repoRoot, 'plugins/subagent/lib/workflow.mjs')) as {
  registerWorkflow(ctx: unknown, getRun: unknown, helpers: unknown): void;
};
const { dependencyContextChunks } = await import(resolve(repoRoot, 'plugins/subagent/index.mjs')) as {
  dependencyContextChunks(raw: unknown, totalChars?: number): string[];
};

function workflowHarness(dir: string, config?: Record<string, unknown>) {
  const tools = new Map<string, WorkflowTool>();
  // A foreground WorkflowStart returns only the summary, so the id comes from the live snapshot stream —
  // the same place the UI reads it.
  const snapshots: { id: string }[] = [];
  const run = async (
    _source: unknown,
    fullTask: string,
    onEvent: (e: { type: string; sessionId?: string; usage?: { totalTokens: number } }) => void,
  ) => {
    onEvent({ type: 'session', sessionId: `s-${fullTask}` });
    onEvent({ type: 'idle', usage: { totalTokens: 10 } });
    return `done:${fullTask}`;
  };
  const ctx = {
    config: config ?? {},
    dataDir: () => dir,
    registerTool: (def: WorkflowTool) => { tools.set(def.name, def); },
    registerControl: () => {},
    stopSubagent: async () => ({ stopped: true }),
    logger: { info() {}, warn() {} },
    currentSessionId: () => 'brain-parent',
    currentIdentity: () => ({ elowenUserId: 1, platform: 'cli', userId: '1' }),
    currentAccess: () => ({}),
    currentModel: () => ({ provider: 'p', model: 'm' }),
    assertPathAllowed: (path: string) => resolve(path),
    workflowEmitter: () => (u: { id: string }) => { snapshots.push(u); },
    listModels: async () => [],
    toolNames: () => ['Read'],
  };
  registerWorkflow(ctx, () => run, {
    resolveDelegateTools: (_inherited: string[] | undefined, requested: string[] | undefined) =>
      (requested ? { allow: requested } : { allow: undefined }),
    principalOf: (identity: unknown) => (identity ? 'elowen:1' : null),
    dependencyContextChunks,
  });
  const get = (name: string): WorkflowTool => {
    const found = tools.get(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };
  return { get, snapshots };
}

describe('subagent result retention — workflows', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workflow-retention-'));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-05-04T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run one trivial workflow to completion and return its id. */
  const runWorkflow = async (harness: ReturnType<typeof workflowHarness>, nodeId: string): Promise<string> => {
    const { writeFileSync } = await import('node:fs');
    const file = join(dir, `${nodeId}.json`);
    writeFileSync(file, JSON.stringify([{ id: nodeId, task: `task ${nodeId}` }]));
    await harness.get('WorkflowStart').execute(`start-${nodeId}`, { nodesFile: file, background: false });
    const id = harness.snapshots.at(-1)?.id;
    if (typeof id !== 'string') throw new Error('WorkflowStart emitted no snapshot');
    return id;
  };

  const statusOf = async (harness: ReturnType<typeof workflowHarness>, id: string): Promise<string> =>
    (await harness.get('WorkflowStatus').execute('st', { workflowId: id })).content[0]?.text ?? '';

  it('forgets a finished workflow once the CONFIGURED retention has passed', async () => {
    const harness = workflowHarness(dir, { resultRetentionMs: 600_000 });
    const first = await runWorkflow(harness, 'alpha');
    expect(await statusOf(harness, first)).toContain(first);

    // Retention is swept when the next workflow starts, which is exactly when the memory is needed back.
    advance(11 * 60_000);
    await runWorkflow(harness, 'beta');
    expect(await statusOf(harness, first)).toContain(`no workflow ${first}`);
  });

  it('keeps a finished workflow past that point when nothing is configured', async () => {
    const harness = workflowHarness(dir);
    const first = await runWorkflow(harness, 'alpha');

    advance(11 * 60_000);
    await runWorkflow(harness, 'beta');
    expect(await statusOf(harness, first)).toContain(first); // still inside the 1 h default

    advance(50 * 60_000);
    await runWorkflow(harness, 'gamma');
    expect(await statusOf(harness, first)).toContain(`no workflow ${first}`);
  });
});
