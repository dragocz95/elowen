import { describe, it, expect, afterEach, vi } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy } from '../../src/plugins/policyContext.js';
import type { TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';

// Delegation is ASYNCHRONOUS by default: a call that says nothing about `background` hands back a handle
// and the result is delivered in a later turn, while `background: false` is the explicit request to wait.
// What the suite pins is the whole contract around that default — the fallback where nothing could carry
// a delivery, the busy-child steer that has no result of its own, and the rule that one piece of work is
// either returned or delivered, never both.
const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pluginsDir = join(repoRoot, 'plugins');
const ADMIN: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const OWNER: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };
const CHILD_SESSION = 'brain-ch-subagent-sub-dlg-existing';

interface ToolResult { content: { text: string }[]; details?: Record<string, unknown> }
interface Executable { execute(id: string, p: unknown): Promise<ToolResult> }
const asText = (r: ToolResult) => r.content[0]?.text ?? '';
const tool = (reg: PluginRegistry, name: string): Executable => {
  const found = reg.tools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found as unknown as Executable;
};

let dirs: string[] = [];
const freshDataRoot = (): string => { const p = mkdtempSync(join(tmpdir(), 'elowen-bgdefault-')); dirs.push(p); return p; };
afterEach(() => {
  for (const p of dirs) rmSync(p, { recursive: true, force: true });
  dirs = [];
});

describe('Delegate — asynchronous delivery is the default', () => {
  /** A registry whose child parks until `release()`, so a call can be observed before the child settles. */
  const harness = async () => {
    const reg = await loadPlugins({ dirs: [pluginsDir], enabled: ['subagent'], dataRoot: freshDataRoot(), logger: log });
    let release!: (reply: string) => void;
    const child = new Promise<string>((resolve_) => { release = resolve_; });
    reg.platforms[0]!.listen(async (_src: unknown, _task: string, onEvent?: (e: unknown) => void) => {
      onEvent?.({ type: 'session', sessionId: 'brain-ch-subagent-sub-dlg-default' });
      return child;
    });
    const completions: { status?: string; result?: string }[] = [];
    return { reg, release, completions };
  };

  it('returns a handle for an omitted background and delivers the result exactly once', async () => {
    const { reg, release, completions } = await harness();
    const res = await runWithPolicy(ADMIN, () => tool(reg, 'Delegate').execute('call-omitted', { task: 'inspect the parser' }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });

    expect(res.details).toMatchObject({ status: 'running' });
    expect(asText(res)).toMatch(/Started background delegation/);
    expect(completions).toEqual([]);
    release('the child conclusion');
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({ status: 'done', result: 'the child conclusion' });
    // The wake-up is one result, not one per observer.
    await new Promise((r) => setTimeout(r, 10));
    expect(completions).toHaveLength(1);
  });

  it('treats an explicit background=true exactly like the default', async () => {
    const { reg, release, completions } = await harness();
    const res = await runWithPolicy(ADMIN, () => tool(reg, 'Delegate').execute('call-true', { task: 'inspect', background: true }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });

    expect(asText(res)).toMatch(/Started background delegation/);
    release('explicit conclusion');
    await vi.waitFor(() => expect(completions).toHaveLength(1));
  });

  it('blocks for an explicit background=false and returns the child text instead of delivering it', async () => {
    const { reg, release, completions } = await harness();
    const call = runWithPolicy(ADMIN, () => tool(reg, 'Delegate').execute('call-false', { task: 'inspect', background: false }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toEqual([]);

    release('the blocking conclusion');
    expect(asText(await call)).toBe('the blocking conclusion');
    // Returned inline, so delivering it as well would hand the parent the same answer twice.
    await new Promise((r) => setTimeout(r, 10));
    expect(completions).toEqual([]);
  });

  // A surface with no durable completion sink (a worker or cron wiring) cannot wake anybody with the
  // result, so an OMITTED background must still block rather than hand back a handle nothing collects.
  it('falls back to blocking where nothing could deliver the result', async () => {
    const { reg, release } = await harness();
    const call = runWithPolicy(ADMIN, () => tool(reg, 'Delegate').execute('call-sinkless', { task: 'inspect' }), {
      sessionId: 'brain-parent', identity: OWNER, emitSubagent: () => {},
    });
    release('sink-less conclusion');
    expect(asText(await call)).toBe('sink-less conclusion');
  });

  it('still names the refusal for an explicit background outside a conversation', async () => {
    const { reg } = await harness();
    const res = await runWithPolicy(ADMIN, () => tool(reg, 'Delegate').execute('call-anon', { task: 'inspect', background: true }));
    expect(asText(res)).toContain('available only inside an authenticated conversation');
  });
});

describe('DelegateContinue — asynchronous delivery for an idle sub-agent', () => {
  /** A registry whose continuation behaves like the host's: an IDLE child emits the turn's `session`
   *  event and answers later, a BUSY one is steered and answers `steered` without running a turn. */
  const harness = async (mode: 'idle' | 'steer') => {
    let release!: (result: { status: 'reply'; reply: string }) => void;
    const reply = new Promise<{ status: 'reply'; reply: string }>((resolve_) => { release = resolve_; });
    const reg = await loadPlugins({
      dirs: [pluginsDir], enabled: ['subagent'], dataRoot: freshDataRoot(), logger: log,
      delegatedChildren: {
        runs: () => [],
        read: () => '',
        continue: async (_parent, _child, _text, _access, onEvent) => {
          if (mode === 'steer') return { status: 'steered' as const };
          onEvent?.({ type: 'session', sessionId: CHILD_SESSION });
          return reply;
        },
        stop: async () => ({ stopped: false }),
      },
    });
    const completions: { status?: string; result?: string; toolCallId?: string }[] = [];
    return { reg, release, completions };
  };

  it('returns once the follow-up turn has started and delivers the reply exactly once', async () => {
    const { reg, release, completions } = await harness('idle');
    const res = await runWithPolicy(ADMIN, () => tool(reg, 'DelegateContinue').execute('call-continue', {
      id: CHILD_SESSION, message: 'check one more edge',
    }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });

    expect(res.details).toMatchObject({ sessionId: CHILD_SESSION, status: 'running' });
    expect(asText(res)).toMatch(/delivered to you automatically in a NEW turn/);
    expect(completions).toEqual([]);
    release({ status: 'reply', reply: 'the continued answer' });
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(completions[0]).toMatchObject({ toolCallId: 'call-continue', status: 'done', result: 'the continued answer' });
    await new Promise((r) => setTimeout(r, 10));
    expect(completions).toHaveLength(1);
  });

  it('blocks for an explicit background=false and returns the reply inline', async () => {
    const { reg, release, completions } = await harness('idle');
    const call = runWithPolicy(ADMIN, () => tool(reg, 'DelegateContinue').execute('call-blocking', {
      id: CHILD_SESSION, message: 'check one more edge', background: false,
    }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(completions).toEqual([]);

    release({ status: 'reply', reply: 'the inline answer' });
    expect(asText(await call)).toBe('the inline answer');
    await new Promise((r) => setTimeout(r, 10));
    expect(completions).toEqual([]);
  });

  // A steered message enters a turn that is already running under another call, so it has no result of
  // its own. Handing back a background handle here would promise a delivery that can never come.
  it('keeps the steer answer for a busy sub-agent and delivers nothing', async () => {
    const { reg, completions } = await harness('steer');
    const res = await runWithPolicy(ADMIN, () => tool(reg, 'DelegateContinue').execute('call-steer', {
      id: CHILD_SESSION, message: 'also check the other branch',
    }), {
      sessionId: 'brain-parent', identity: OWNER,
      emitSubagent: () => {}, emitSubagentCompletion: (c) => completions.push(c as { status?: string }),
    });

    expect(res.details).toMatchObject({ steered: true });
    expect(asText(res)).toContain('steered into its RUNNING turn');
    expect(asText(res)).not.toMatch(/Started/);
    await new Promise((r) => setTimeout(r, 10));
    expect(completions).toEqual([]);
  });

  it('falls back to blocking where nothing could deliver the reply', async () => {
    const { reg, release } = await harness('idle');
    const call = runWithPolicy(ADMIN, () => tool(reg, 'DelegateContinue').execute('call-sinkless', {
      id: CHILD_SESSION, message: 'check one more edge',
    }), { sessionId: 'brain-parent', identity: OWNER, emitSubagent: () => {} });
    release({ status: 'reply', reply: 'sink-less answer' });
    expect(asText(await call)).toBe('sink-less answer');
  });
});
