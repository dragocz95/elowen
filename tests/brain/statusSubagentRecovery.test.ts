import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { BrainStatusService } from '../../src/brain/service/statusService.js';
import { ConversationLifecycle } from '../../src/brain/service/lifecycle.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { ClientAttachments } from '../../src/brain/service/attachments.js';
import { ElicitationRegistry } from '../../src/brain/elicitation.js';
import { CardRegistry } from '../../src/brain/cards.js';
import { PermissionApprovalService } from '../../src/brain/service/permissionApproval.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-recovery';
const TOOL_CALL = 'call-recovery';

function harness() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const sessions = new LiveSessionRegistry<LiveBrain>();
  const elicitation = new ElicitationRegistry();
  const lifecycle = new ConversationLifecycle({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    goals: { cancelGoalContinuation: () => {} } as unknown as ConstructorParameters<typeof ConversationLifecycle>[0]['goals'],
    spawn: () => Promise.reject(new Error('no spawn in this harness')),
    selectionAllowed: () => true,
  });
  const status = new BrainStatusService({
    store,
    sessions,
    attachments: new ClientAttachments(),
    elicitation,
    cards: new CardRegistry(),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  store.createSession({ id: PARENT, userId: 1, model: 'm' });
  store.createSession({
    id: CHILD,
    userId: 1,
    model: 'm',
    parentSessionId: PARENT,
    delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
  });
  store.appendMessage({
    id: 'assistant-delegate',
    sessionId: PARENT,
    parentId: null,
    role: 'assistant',
    content: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: TOOL_CALL, name: 'Delegate', arguments: { task: 'recover me' } }],
    },
  });
  return { db, store, sessions, status };
}

function projectedSubagent(status: BrainStatusService) {
  const assistant = status.messagesOf(1, PARENT).find((message) => message.role === 'assistant');
  const tool = assistant?.segments?.find((segment) => segment.kind === 'tool');
  return tool?.kind === 'tool' ? tool.sub : undefined;
}

describe('sub-agent recovery status projection', () => {
  it('shows a boot-claimed recovery as running before its child turn registers live', () => {
    const { store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL,
      sessionId: CHILD,
      status: 'running',
      task: 'recover me',
      tools: 2,
      seconds: 10,
      background: true,
      autoDeliver: true,
    })).toBe(true);

    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns()).toHaveLength(1);

    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'recover me' });
  });

  it('shows a recovering claim a dead boot left behind exactly as DelegateList does: the boot claims it, the rail shows it', () => {
    // Production, 5 Sep 12:53 (parent brain-1-mrxd…, child …b8d67a3bb808): the boot before had claimed the
    // child for recovery and was restarted mid-recovery. The rail keyed liveness on "this boot's claims"
    // and showed nothing, while the DelegateList tool (lifecycle-based) told the agent the child was
    // running — two answers to one question. Both now read the durable lifecycle, and the claim itself no
    // longer skips a dead boot's `recovering` row, so the row is this boot's the moment it boots.
    const { db, store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'dead boot', tools: 0, seconds: 1,
    })).toBe(true);
    store.setDelegationBootId('boot-dead');
    expect(store.claimRecoverableRuns()).toHaveLength(1);
    db.prepare('UPDATE brain_subagent_runs SET lease_until = ? WHERE tool_call_id = ?').run(Date.now() + 60_000, TOOL_CALL);

    store.setDelegationBootId('boot-new');
    // Even before this boot's claim pass the read model agrees with the listing…
    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'dead boot' });
    expect(store.listDelegatedChildren(PARENT)[0]).toMatchObject({ sessionId: CHILD, status: 'running' });
    // …and the claim takes the row over despite the unexpired lease, so a worker exists for what is shown.
    expect(store.claimRecoverableRuns()).toHaveLength(1);
    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'dead boot' });
  });

  it('the stream snapshot a reconnecting client hydrates from carries the recovering child as running', () => {
    // The CLI rail is projected from the snapshot's history sidecars, not from a separate children list;
    // a boot-claimed child with no live record and no registry edge yet must be in that frame.
    const { store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'recover me', tools: 2, seconds: 10,
    })).toBe(true);
    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns()).toHaveLength(1);

    const snapshot = status.streamSnapshot(1, PARENT);
    const subs = snapshot.history
      .flatMap((message) => message.segments ?? [])
      .filter((segment): segment is Extract<typeof segment, { kind: 'tool' }> => segment.kind === 'tool')
      .map((segment) => segment.sub)
      .filter((sub): sub is NonNullable<typeof sub> => !!sub);
    expect(subs).toEqual([expect.objectContaining({ sessionId: CHILD, status: 'running', task: 'recover me' })]);
  });

  it('keeps an expired current-boot recovery claim visible while it waits in the serial queue', () => {
    const { db, store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'queued', tools: 0, seconds: 1,
    })).toBe(true);
    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns()).toHaveLength(1);
    db.prepare('UPDATE brain_subagent_runs SET lease_until = ? WHERE tool_call_id = ?').run(Date.now() - 1, TOOL_CALL);

    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'queued' });
  });

  it('names ONE state per child — its newest run — when a DelegateContinue row follows a finished Delegate row', () => {
    // Production shape (4 Sep, parent brain-1-mrxd…): the same child has TWO run rows, the original Delegate
    // (done, older) and a later DelegateContinue (recovering after the pause, newer, updated_at frozen at
    // the SIGTERM time). The parent's loaded page holds only the older Delegate tool row, so the newer run
    // arrives as a prepended synthetic anchor — and the CLI, keyed by child session, let the older row's
    // `done` overwrite it. The read model must speak with one voice: the newest row, running.
    const { db, store, status } = harness();
    const CONTINUE_CALL = 'call-continue|fc_2';
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'done', task: 'first ask', tools: 40, seconds: 900,
    })).toBe(true);
    expect(store.upsertSubagentRun(PARENT, {
      id: CONTINUE_CALL, sessionId: CHILD, status: 'running', task: 'continue: fix the blockers', tools: 3, seconds: 60,
    })).toBe(true);
    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns()).toHaveLength(1);
    // The recovering row's updated_at stays frozen at the pause; the finished row was touched later
    // (a late delivery acknowledgement). updated_at must not decide which row is the newest.
    db.prepare("UPDATE brain_subagent_runs SET updated_at = '2020-01-01 00:00:00' WHERE tool_call_id = ?").run(CONTINUE_CALL);
    db.prepare("UPDATE brain_subagent_runs SET updated_at = '2030-01-01 00:00:00' WHERE tool_call_id = ?").run(TOOL_CALL);

    const states = status.messagesOf(1, PARENT)
      .flatMap((message) => message.segments ?? [])
      .filter((segment): segment is Extract<typeof segment, { kind: 'tool' }> => segment.kind === 'tool')
      .map((segment) => segment.sub)
      .filter((sub): sub is NonNullable<typeof sub> => !!sub && sub.sessionId === CHILD);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: 'running', task: 'continue: fix the blockers' });
  });

  it('a newer row stuck at display `running` under a terminal lifecycle must not hide the child: the older finished row speaks', () => {
    // Production DB shape (27 pairs under brain-1-mrxd…): the DelegateContinue row's final upsert never
    // landed, so its JSON status is still `running` while its lifecycle is `done` and nothing is live.
    // The liveness filter hides that row; the child is finished and its older `done` row must survive
    // — a "newest row wins, then filter" order lost 20 of 254 children from the page.
    const { db, store, status } = harness();
    const CONTINUE_CALL = 'call-continue|fc_3';
    store.setDelegationBootId('boot-x');
    expect(store.upsertSubagentRun(PARENT, { id: TOOL_CALL, sessionId: CHILD, status: 'done', task: 'first ask', tools: 40, seconds: 900 })).toBe(true);
    expect(store.upsertSubagentRun(PARENT, { id: CONTINUE_CALL, sessionId: CHILD, status: 'running', task: 'continue', tools: 3, seconds: 60 })).toBe(true);
    db.prepare("UPDATE brain_subagent_runs SET lifecycle = 'done', owner_boot_id = NULL WHERE tool_call_id = ?").run(CONTINUE_CALL);

    const states = status.messagesOf(1, PARENT)
      .flatMap((message) => message.segments ?? [])
      .filter((segment): segment is Extract<typeof segment, { kind: 'tool' }> => segment.kind === 'tool')
      .map((segment) => segment.sub)
      .filter((sub): sub is NonNullable<typeof sub> => !!sub && sub.sessionId === CHILD);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: 'done', task: 'first ask' });
  });

  it('renders recovery_required as a terminal error with the durable reason', () => {
    const { store, status } = harness();
    store.setDelegationBootId('boot-old');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'unsafe', tools: 1, seconds: 2,
    })).toBe(true);
    store.setDelegationBootId('boot-new');
    expect(store.claimRecoverableRuns()).toHaveLength(1);
    expect(store.markRecoveryRequired(PARENT, TOOL_CALL, 'unanswered Write after restart', {
      id: 'result-recovery', toolCallId: TOOL_CALL, sessionId: CHILD, status: 'error', task: 'unsafe',
      error: 'manual continuation required', tools: 1, seconds: 2,
    })).toBe(true);

    expect(projectedSubagent(status)).toMatchObject({
      sessionId: CHILD, status: 'error', task: 'unsafe', detail: 'unanswered Write after restart',
    });
  });

  it('a row whose lifecycle is still open shows as running whatever the registry says — the same answer DelegateList gives', () => {
    // The durable lifecycle is the one source: a call registered in the live registry but not yet written
    // shows nothing (there is no row), a row still `running` shows running. The transient window in which a
    // finished call's terminal row has not landed is the price of never disagreeing with the tool.
    const { store, status } = harness();
    store.setDelegationBootId('boot-current');
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'open', tools: 0, seconds: 1,
    })).toBe(true);
    expect(projectedSubagent(status)).toMatchObject({ sessionId: CHILD, status: 'running', task: 'open' });
    expect(store.listDelegatedChildren(PARENT)[0]).toMatchObject({ sessionId: CHILD, status: 'running' });

    // …and a display `running` under a closed lifecycle (a steered continuation's own row) is not live.
    expect(store.upsertSubagentRun(PARENT, {
      id: TOOL_CALL, sessionId: CHILD, status: 'running', task: 'open', tools: 0, seconds: 1,
    }, 'done')).toBe(true);
    expect(projectedSubagent(status)).toBeUndefined();
    expect(store.listDelegatedChildren(PARENT)[0]).toMatchObject({ sessionId: CHILD, status: 'done' });
  });
});
