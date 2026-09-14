import { describe, it, expect, beforeEach } from 'vitest';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../../src/plugins/loader.js';
import { runWithPolicy, type TurnIdentity } from '../../src/plugins/policyContext.js';
import type { Policy } from '../../src/plugins/policy.js';
import type { PluginRegistry } from '../../src/plugins/registry.js';
import type { DelegatedChildSummary } from '../../src/store/brainDelegationStore.js';
import type { SubagentProgressEvent } from '../../src/plugins/api.js';
import type { SubagentUpdate } from '../../src/brain/events.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';

const log = { info() {}, warn() {}, error() {} };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminPolicy: Policy = { allowedProjectIds: 'all', allowedPaths: () => [] };
const owner: TurnIdentity = { platform: 'elowen', userId: '1', elowenUserId: 1, admin: true, owner: true };

const child = (over: Partial<DelegatedChildSummary> & { sessionId: string }): DelegatedChildSummary => ({
  title: 'Some sub-agent', messages: 4, startedAt: '2026-07-26 20:00:00', updatedAt: '2026-07-26 20:05:00', ...over,
});

describe('subagent plugin — listing and continuing past sub-agents', () => {
  let reg: PluginRegistry;
  /** What the HOST would return for each parent session. The plugin never names a parent, so this map
   *  standing in for the store is also the assertion that scoping happens host-side. */
  let byParent: Map<string, DelegatedChildSummary[]>;
  let asked: { parent: string; limit?: number }[];
  let read: { parent: string; child: string }[];
  let continued: { parent: string; child: string; text: string }[];
  let steeredInto: { parent: string; child: string; text: string }[];
  /** Progress the host feeds back through the callback the plugin now passes down — a test sets it to
   *  drive one tool + token update before the continuation resolves. */
  let continueProgress: ((onEvent?: (e: SubagentProgressEvent) => void) => void) | undefined;
  /** Children the host currently considers live. The REAL LiveSessionRegistry, not a lookalike Set: the
   *  registry is the SAME structure a `running` progress update writes to — which is exactly how a
   *  continuation could end up steering into its own progress row, and how a steered continuation's
   *  terminal row could deregister a child whose original run is still in flight. The mock host below
   *  steers into a live child just as the real one does (resolving {status:'steered'} instead of running
   *  a fresh turn). */
  let registry: LiveSessionRegistry<{ sessionId: string; session: { dispose(): void; isStreaming: boolean } }>;
  let readResult: string | Error;
  let reply: string | Error;
  let stopped: { parent: string; child: string }[];
  let stopResult: { stopped: boolean } | Error;
  /** When true, the stop mock answers from the registry exactly like DelegatedSessionService.stopSubagent
   *  ({stopped:false} for a child no longer registered) instead of the fixed stopResult. */
  let stopFromRegistry: boolean;

  beforeEach(async () => {
    byParent = new Map();
    asked = [];
    read = [];
    continued = [];
    steeredInto = [];
    continueProgress = undefined;
    registry = new LiveSessionRegistry();
    stopped = [];
    readResult = 'the stored final answer';
    reply = 'the sub-agent answered';
    stopResult = { stopped: true };
    stopFromRegistry = false;
    reg = await loadPlugins({
      dirs: [join(repoRoot, 'plugins')], enabled: ['subagent'], logger: log,
      delegatedChildren: {
        runs: (parent, limit) => { asked.push({ parent, limit }); return byParent.get(parent) ?? []; },
        read: (parent, childSessionId) => {
          read.push({ parent, child: childSessionId });
          if (readResult instanceof Error) throw readResult;
          return readResult;
        },
        continue: async (parent, childSessionId, text, _access, onEvent) => {
          // The real host STEERS a child with a turn in flight (the message rides PI's steering queue
          // inside that turn) and resolves {status:'steered'} with no reply. Its guards run synchronously
          // before the first await, so this mock checks synchronously too.
          if (registry.isActiveChild(childSessionId)) {
            steeredInto.push({ parent, child: childSessionId, text });
            return { status: 'steered' };
          }
          continued.push({ parent, child: childSessionId, text });
          continueProgress?.(onEvent);
          if (reply instanceof Error) throw reply;
          return { status: 'reply', reply };
        },
        stop: async (parent, childSessionId) => {
          stopped.push({ parent, child: childSessionId });
          if (stopResult instanceof Error) throw stopResult;
          // Mirrors DelegatedSessionService.stopSubagent: a child no longer registered is nothing to stop.
          if (stopFromRegistry) return { stopped: registry.isActiveChild(childSessionId) };
          return stopResult;
        },
      },
    });
  });

  const call = (
    name: string,
    params: Record<string, unknown>,
    sessionId?: string,
    emitSubagent?: (u: SubagentUpdate) => void,
  ) => {
    const tool = reg.tools.find((t) => t.name === name)!;
    return runWithPolicy(
      adminPolicy,
      () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[]; details?: Record<string, unknown> }> })
        .execute('call', params),
      { identity: owner, ...(sessionId ? { sessionId } : {}), ...(emitSubagent ? { emitSubagent } : {}) },
    );
  };

  /** The production emitter's one relevant effect, with production semantics: a progress update writes
   *  the registry under the 'progress' source (see turnContextBuilder/channels emitSubagent) — a
   *  `running` update raises the emitter's claim, a terminal one releases ONLY that claim, never the
   *  delegated call's own. Without an emitter bound (most tests here) the plugin's progress pushes are
   *  no-ops, which is precisely why the self-refusal never showed up in this suite before. */
  const registerLive = (u: SubagentUpdate): void => {
    registry.setChildRunning('brain-1', u.sessionId, u.status === 'running', 'progress');
  };

  describe('DelegateList', () => {
    it('shows each past sub-agent with its id, task, outcome and transcript size', async () => {
      byParent.set('brain-1', [child({
        sessionId: 'brain-ch-subagent-sub-dlg-abc', task: 'Audit the auth module for missing checks',
        status: 'done', messages: 12, model: 'claude-sonnet',
      })]);
      const res = await call('DelegateList', {}, 'brain-1');
      const text = res.content[0]!.text;
      expect(text).toContain('brain-ch-subagent-sub-dlg-abc');
      expect(text).toContain('Audit the auth module for missing checks');
      expect(text).toContain('done');
      expect(text).toContain('12');
      expect(text).toContain('claude-sonnet');
    });

    // A child the engine never wrote a run row for (a workflow node) is still listable and continuable;
    // the session title is what identifies it.
    it('falls back to the session title when there is no recorded task', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-wf-w1-node', title: 'Ořezávání výsledků' })]);
      const res = await call('DelegateList', {}, 'brain-1');
      expect(res.content[0]!.text).toContain('Ořezávání výsledků');
    });

    it('says so plainly when this conversation has delegated nothing yet', async () => {
      const res = await call('DelegateList', {}, 'brain-1');
      expect(res.content[0]!.text).toMatch(/no sub-agents/i);
    });

    // THE security property: the tool takes no parent parameter, so the only conversation it can ever
    // report on is the one the current turn runs in. Two conversations, two disjoint answers.
    it('is scoped to the current conversation and cannot be pointed at another', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-sub-mine', task: 'mine' })]);
      byParent.set('brain-2', [child({ sessionId: 'brain-ch-subagent-sub-theirs', task: 'theirs' })]);

      const mine = await call('DelegateList', {}, 'brain-1');
      expect(mine.content[0]!.text).toContain('sub-mine');
      expect(mine.content[0]!.text).not.toContain('sub-theirs');

      const theirs = await call('DelegateList', {}, 'brain-2');
      expect(theirs.content[0]!.text).toContain('sub-theirs');
      expect(theirs.content[0]!.text).not.toContain('sub-mine');

      expect(asked.map((a) => a.parent)).toEqual(['brain-1', 'brain-2']);
    });

    it('lists nothing outside a conversation turn rather than falling back to some other parent', async () => {
      byParent.set('brain-1', [child({ sessionId: 'brain-ch-subagent-sub-mine' })]);
      const res = await call('DelegateList', {});
      expect(res.content[0]!.text).toMatch(/no sub-agents/i);
      expect(asked).toEqual([]);
    });
  });

  describe('DelegateRead', () => {
    it('pages stored text with exact ranges and an unambiguous next offset', async () => {
      readResult = 'abcdefghij';

      const first = await call('DelegateRead', {
        id: 'brain-ch-subagent-sub-dlg-abc', offset: 3, limit: 4,
      }, 'brain-1');
      expect(read).toEqual([{ parent: 'brain-1', child: 'brain-ch-subagent-sub-dlg-abc' }]);
      expect(first.content[0]!.text).toContain('10 characters total');
      expect(first.content[0]!.text).toContain('returned range [3, 7)');
      expect(first.content[0]!.text).toContain('"offset":7');
      expect(first.content[0]!.text).toMatch(/\n\ndefg$/);
      expect(first.details).toMatchObject({
        offset: 3, end: 7, totalLength: 10, returnedLength: 4, hasMore: true, nextOffset: 7,
      });

      const last = await call('DelegateRead', {
        id: 'brain-ch-subagent-sub-dlg-abc', offset: 7, limit: 4,
      }, 'brain-1');
      expect(last.content[0]!.text).toContain('returned range [7, 10)');
      expect(last.content[0]!.text).toContain('complete remaining text');
      expect(last.content[0]!.text).toMatch(/\n\nhij$/);
      expect(last.details).toMatchObject({
        offset: 7, end: 10, totalLength: 10, returnedLength: 3, hasMore: false,
      });
      expect(last.details?.nextOffset).toBeUndefined();
    });

    it('returns an unknown id as a readable recoverable error instead of throwing', async () => {
      readResult = new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
      const res = await call('DelegateRead', { id: 'brain-ch-subagent-nope' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/use DelegateList/);
    });

    it('returns missing final text as a readable recoverable error instead of throwing', async () => {
      readResult = new Error('that sub-agent has not produced final assistant text yet — wait for it to finish, then try DelegateRead again');
      const res = await call('DelegateRead', { id: 'brain-ch-subagent-sub-running' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/wait for it to finish/);
    });

    it('refuses outside a conversation turn rather than falling back to another parent', async () => {
      const res = await call('DelegateRead', { id: 'brain-ch-subagent-sub-dlg-abc' });
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(read).toEqual([]);
    });
  });

  describe('DelegateContinue', () => {
    it('describes the mid-turn behavior as steering, not refusal', () => {
      const tool = reg.tools.find((t) => t.name === 'DelegateContinue')!;
      // The description is what the agent plans against: it must not keep promising the old refusal.
      expect(tool.description).not.toMatch(/refused rather than interrupted/);
      expect(tool.description).toMatch(/steered/);
    });

    it('sends the follow-up to that child and returns what it answered', async () => {
      reply = 'checked the tests too — all green';
      const res = await call('DelegateContinue',
        { id: 'brain-ch-subagent-sub-dlg-abc', message: 'also check the tests' }, 'brain-1');
      expect(continued).toEqual([{
        parent: 'brain-1', child: 'brain-ch-subagent-sub-dlg-abc', text: 'also check the tests',
      }]);
      expect(res.content[0]!.text).toBe('checked the tests too — all green');
    });

    it('anchors the continuation on the CURRENT conversation, never on a caller-supplied parent', async () => {
      await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: 'hi' }, 'brain-2');
      expect(continued[0]!.parent).toBe('brain-2');
    });

    // A refusal (foreign child, scope now too wide) has to come back as a readable result the agent can
    // act on — waiting, or picking another child — not as a thrown tool failure.
    it('reports a host refusal as an actionable error instead of throwing', async () => {
      reply = new Error('cannot continue that sub-agent: its captured scope grants more than this conversation holds');
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-wide', message: 'hi' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/cannot continue/);
    });

    // The progress row and the host's "is this child busy?" guard read and write the SAME live-child
    // registry. Raising the row before asking the host therefore made every continuation report ITSELF as
    // busy: the operator saw "that sub-agent is still running" for a child that had long finished.
    it('does not report itself busy through the progress row it just raised', async () => {
      reply = 'picked up where I left off';
      const res = await call('DelegateContinue',
        { id: 'brain-ch-subagent-sub-dlg-abc', message: 'now check the tests' }, 'brain-1', registerLive);

      expect(res.content[0]!.text).toBe('picked up where I left off');
      expect(continued).toEqual([{
        parent: 'brain-1', child: 'brain-ch-subagent-sub-dlg-abc', text: 'now check the tests',
      }]);
    });

    it('asks the host first, then raises the running row — and clears it when done', async () => {
      // Pins the ordering the fix depends on, so it cannot be swapped back without a red test.
      const order: string[] = [];
      continueProgress = () => { order.push('host-asked'); };
      await call('DelegateContinue', { id: 'brain-ch-subagent-sub-dlg-abc', message: 'go on' }, 'brain-1',
        (u) => { order.push(`row:${u.status}`); registerLive(u); });

      expect(order).toEqual(['host-asked', 'row:running', 'row:done']);
      // The row still gets raised, so a live continuation is visible in the rail rather than running blind.
      expect(registry.isActiveChild('brain-ch-subagent-sub-dlg-abc')).toBe(false);
    });

    // The new mid-turn behavior: a busy child is steered, not refused. The tool must say plainly that no
    // separate reply exists (the result rides the delegation's own result path), so the parent does not
    // sit polling for an answer that will never come through this call.
    it('steers into a child whose turn is in flight and reports there is no separate reply', async () => {
      // The child's ORIGINAL delegated run holds its lifecycle claim — the default 'call' source, exactly
      // as beginDelegatedCall registers it. It is what makes the mock host steer instead of running a turn.
      registry.setChildRunning('brain-1', 'brain-ch-subagent-busy', true);
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-busy', message: 'also check the docs' }, 'brain-1', registerLive);

      expect(steeredInto).toEqual([{ parent: 'brain-1', child: 'brain-ch-subagent-busy', text: 'also check the docs' }]);
      expect(continued).toEqual([]); // never also ran as a fresh idle turn — that would double-deliver
      expect(res.content[0]!.text).toMatch(/steered into its RUNNING turn/);
      expect(res.content[0]!.text).toMatch(/no separate reply/);
      expect(res.details).toMatchObject({ steered: true });
      // The continuation settled its own progress row ('done'), but the child's original run is STILL in
      // flight — its claim must survive, or the child becomes unstoppable and invisible to abort/shutdown.
      expect(registry.isActiveChild('brain-ch-subagent-busy')).toBe(true);
      stopFromRegistry = true;
      const stop = await call('DelegateStop', { id: 'brain-ch-subagent-busy' }, 'brain-1');
      expect(stopped).toEqual([{ parent: 'brain-1', child: 'brain-ch-subagent-busy' }]);
      expect(stop.content[0]!.text).toBe('Stopped.');
    });

    // The narrow remaining refusal (child active but not steerable anywhere — turn queued for a runner
    // slot, or collecting between turns) must still come back as a readable, retryable result.
    it('reports the between-steps refusal as an actionable error instead of throwing', async () => {
      reply = new Error('that sub-agent is busy between model steps (starting up or collecting background work) and cannot take a steered message right now — try again in a moment');
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-gap', message: 'hi' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/try again in a moment/);
    });

    it('refuses outside a conversation turn', async () => {
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: 'hi' });
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(continued).toEqual([]);
    });

    it('refuses an empty follow-up rather than waking the child with nothing to do', async () => {
      const res = await call('DelegateContinue', { id: 'brain-ch-subagent-x', message: '   ' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(continued).toEqual([]);
    });

    // The bug: a continuation ran invisibly because no progress reached the parent, so the rail never
    // showed it as a running sub-agent the way a first Delegate does. It must raise a running row keyed on
    // THIS tool call, reflect the child's live tool/token progress, and settle to done.
    it('surfaces the follow-up as a running sub-agent and fans its progress out to the host', async () => {
      reply = 'refined and re-checked';
      continueProgress = (onEvent) => {
        onEvent?.({ type: 'tool', name: 'Read', detail: 'a.ts' });
        onEvent?.({ type: 'idle', usage: { totalTokens: 500, effectiveTps: 42.5, effectiveTurnId: 'turn-1', effectiveModel: 'provider/model' } });
        onEvent?.({ type: 'step', usage: { totalTokens: 520, effectiveTurnId: 'turn-1', effectiveModel: 'provider/model' } });
      };
      const updates: SubagentUpdate[] = [];
      const tool = reg.tools.find((t) => t.name === 'DelegateContinue')!;
      const res = await runWithPolicy(
        adminPolicy,
        () => (tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> })
          .execute('call-42', { id: 'brain-ch-subagent-x', message: 'refine it' }),
        { identity: owner, sessionId: 'brain-1', emitSubagent: (u) => updates.push(u) },
      );

      expect(res.content[0]!.text).toBe('refined and re-checked');
      // A running row appears up front, keyed on this call id and the child's session (drill-in target).
      expect(updates[0]).toMatchObject({ id: 'call-42', sessionId: 'brain-ch-subagent-x', status: 'running' });
      expect(updates.some((u) => u.status === 'running' && u.tools === 1 && u.detail === 'Read a.ts')).toBe(true);
      expect(updates.some((u) => u.tokens === 500)).toBe(true);
      expect(updates.at(-1)).toMatchObject({
        status: 'done', tokens: 520, effectiveTps: 42.5,
        effectiveTurnId: 'turn-1', effectiveModel: 'provider/model',
      });
    });

    // The host aborts an in-flight continuation exactly like any delegated send: requestPendingAbort
    // makes the channel turn throw 'delegation aborted'. That must reach the parent as a readable result
    // (it can wait, or pick another child) and settle the rail row it raised — never leave it claiming
    // the child is still running.
    it('surfaces an abort mid-continuation as a readable error and settles the progress row', async () => {
      reply = new Error('delegation aborted');
      continueProgress = (onEvent) => {
        onEvent?.({ type: 'tool', name: 'Read', detail: 'a.ts' });
      };
      const updates: SubagentUpdate[] = [];
      const tool = reg.tools.find((t) => t.name === 'DelegateContinue');
      expect(tool).toBeDefined();
      const executor = tool as unknown as { execute: (id: string, p: unknown) => Promise<{ content: { text: string }[] }> };
      const res = await runWithPolicy(
        adminPolicy,
        () => executor.execute('call-43', { id: 'brain-ch-subagent-x', message: 'keep going' }),
        { identity: owner, sessionId: 'brain-1', emitSubagent: (u) => updates.push(u) },
      );

      expect(res.content[0]?.text).toBe('Error: delegation aborted');
      // The row was raised as running, mirrored the child's tool progress, then settled terminal.
      expect(updates[0]).toMatchObject({ id: 'call-43', sessionId: 'brain-ch-subagent-x', status: 'running' });
      expect(updates.some((u) => u.status === 'running' && u.tools === 1 && u.detail === 'Read a.ts')).toBe(true);
      expect(updates.at(-1)).toMatchObject({ status: 'error' });
    });
  });

  describe('DelegateStop', () => {
    it('stops that child and reports success', async () => {
      const res = await call('DelegateStop', { id: 'brain-ch-subagent-sub-dlg-abc' }, 'brain-1');
      expect(stopped).toEqual([{ parent: 'brain-1', child: 'brain-ch-subagent-sub-dlg-abc' }]);
      expect(res.content[0]!.text).toBe('Stopped.');
    });

    it('anchors the stop on the CURRENT conversation, never on a caller-supplied parent', async () => {
      await call('DelegateStop', { id: 'brain-ch-subagent-x' }, 'brain-2');
      expect(stopped[0]!.parent).toBe('brain-2');
    });

    it('reports a child that already finished as nothing to stop, not an error', async () => {
      stopResult = { stopped: false };
      const res = await call('DelegateStop', { id: 'brain-ch-subagent-x' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Nothing to stop/);
    });

    // A refusal (foreign child, unknown id) has to come back as a readable result the agent can act on,
    // not as a thrown tool failure — same contract as DelegateRead/DelegateContinue.
    it('reports a host refusal as an actionable error instead of throwing', async () => {
      stopResult = new Error('unknown sub-agent for this conversation — use DelegateList to choose an id from this conversation');
      const res = await call('DelegateStop', { id: 'brain-ch-subagent-someone-elses' }, 'brain-1');
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(res.content[0]!.text).toMatch(/unknown sub-agent/);
    });

    it('refuses outside a conversation turn rather than falling back to another parent', async () => {
      const res = await call('DelegateStop', { id: 'brain-ch-subagent-x' });
      expect(res.content[0]!.text).toMatch(/^Error: /);
      expect(stopped).toEqual([]);
    });
  });
});
