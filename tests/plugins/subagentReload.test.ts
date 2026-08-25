import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { PluginHookBus } from '../../src/plugins/hookBus.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { SubagentUpdate, SubagentCompletion } from '../../src/brain/events.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

// The job registry lives in a per-instance closure, and a plugin reload swaps that closure — emitters,
// the `run` handler and the adapter behind them all die with it. A background job caught mid-flight would
// otherwise keep running with nothing left to report through, and the parent would wait forever. The
// plugin settles every running job terminal in a `plugin.reload.before` hook and delivers the verdict;
// these tests exercise that boundary through the real hook bus.
describe('subagent plugin — job registry across a plugin reload', () => {
  let dataRoot: string;
  let warnings: string[];
  let updates: SubagentUpdate[];
  let completions: SubagentCompletion[];
  let resolveChild: ((reply: string) => void) | undefined;
  let childReply: Promise<string>;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'subagent-reload-'));
    warnings = [];
    updates = [];
    completions = [];
    childReply = new Promise((res) => { resolveChild = res; });
  });

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const load = () => loadPlugins({
    dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], dataRoot,
    logger: { info() {}, warn: (msg: string) => warnings.push(msg), error() {} },
    delegatedChildren: {
      runs: () => [],
      read: () => { throw new Error('not used in this suite'); },
      continue: async () => { throw new Error('not used in this suite'); },
      stop: async () => ({ stopped: false }),
    },
  });

  /** Start one background delegation whose child stays in flight until the test resolves `childReply` —
   *  the stand-in host hands the plugin the pending promise and reports the child's session up front. */
  const delegateBackground = async (reg: PluginRegistry, sessionId = 'brain-1') => {
    const platform = reg.platforms.find((p) => p.name === 'subagent');
    if (!platform) throw new Error('subagent platform not registered');
    platform.listen(async (_src, _task, onEvent) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-test' });
      return childReply;
    });
    const tool = reg.tools.find((t) => t.name === 'Delegate');
    if (!tool) throw new Error('Delegate tool not registered');
    const executor = tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }>;
    };
    const res = await runWithPolicy(
      adminPolicy,
      () => executor.execute('call-1', { task: 'background task', background: true }),
      {
        identity: owner, sessionId,
        emitSubagent: (u) => updates.push(u),
        emitSubagentCompletion: (c) => completions.push(c),
      },
    );
    return res.details?.jobId as string;
  };

  const reload = (reg: PluginRegistry) =>
    new PluginHookBus({ hooks: reg.hooks }).emit('plugin.reload.before', {});

  it('settles a running background job as interrupted at reload, delivers the completion and answers afterwards', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);
    expect(jobId).toMatch(/^dlg-/);

    await reload(reg);

    // The parent is told the real reason through the durable sink, not a later cryptic 'delegation
    // aborted' from the host's abort cascade, and the rail row settles terminal.
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'error', error: 'interrupted by plugin reload' });
    expect(updates.at(-1)).toMatchObject({ status: 'error' });
    const logged = warnings.join('\n');
    expect(logged).toMatch(/still running at plugin reload/);
    expect(logged).toContain(jobId);

    // The old closure finishing afterwards must not flip the verdict or deliver a second completion.
    // Its emitters are dead, but the promise it was awaiting still resolves.
    resolveChild?.('finished after reload');
    await new Promise((r) => setTimeout(r, 0));
    expect(completions).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ status: 'error' });
    const firstError = updates.findIndex((u) => u.status === 'error');
    expect(firstError).toBeGreaterThanOrEqual(0);
    expect(updates.slice(firstError + 1).every((u) => u.status === 'error')).toBe(true);
  });

  it('leaves a job that already finished before the reload alone', async () => {
    const reg = await load();
    const jobId = await delegateBackground(reg);
    resolveChild?.('the final answer');
    await new Promise((r) => setTimeout(r, 0));
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ id: jobId, status: 'done', result: 'the final answer' });

    await reload(reg);
    // Only RUNNING jobs are interrupted. A finished one must not be re-settled into an error, must not
    // deliver a second completion, and must not appear in the "still running" warning.
    expect(warnings.some((warning) => warning.includes('still running at plugin reload'))).toBe(false);
    expect(completions).toHaveLength(1);
    expect(updates.at(-1)).toMatchObject({ status: 'done' });
  });
});
