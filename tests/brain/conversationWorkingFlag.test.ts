import { describe, it, expect } from 'vitest';
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

// The incident this file guards: the web's Chat badge counted the instance pulse's `runningAgents` — every
// running SUB-AGENT SESSION on the instance, derived from live streaming state. Two of the reader's own
// conversations, each waiting on a delegated child, badged as ONE, because a child sitting in a tool call
// is not streaming and never entered that figure. The count belongs on the conversations the reader can
// open, and its truth is `SessionListItem.working`: the durable activity claim OR a live delegated child.

const OWNER = 1;
const OTHER = 2;

function harness() {
  const store = new BrainStore(openDb(':memory:'));
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
    cards: new CardRegistry(() => store),
    lifecycle,
    permissions: new PermissionApprovalService({ elicitation }),
    config: undefined,
    runtime: undefined as unknown as ConstructorParameters<typeof BrainStatusService>[0]['runtime'],
  });
  return { store, sessions, status };
}

/** A conversation only enters the listing once somebody has spoken in it (unspoken shells are withheld). */
function conversation(store: BrainStore, id: string, userId = OWNER): void {
  store.createSession({ id, userId, model: 'm', provider: 'p' });
  store.appendMessage({ id: `${id}-u`, sessionId: id, parentId: null, role: 'user', content: { role: 'user', content: 'hi' } });
}

const workingIds = (rows: { id: string; working: boolean }[]): string[] =>
  rows.filter((row) => row.working).map((row) => row.id);

describe('conversation listing — the working flag behind the Chat count', () => {
  it('counts a conversation whose own durable turn is working', () => {
    const { store, status } = harness();
    conversation(store, 'brain-1-a');
    conversation(store, 'brain-1-b');
    store.beginSessionActivity('brain-1-a', 'turn-a', 'web');

    expect(workingIds(status.listSessions(OWNER))).toEqual(['brain-1-a']);
  });

  it('counts a parent whose delegated child is still running after its own turn settled', () => {
    // A BACKGROUND delegation: the parent's turn is done and its durable activity says so, while the agent
    // it started keeps working. Reading the durable state alone reports this conversation as idle, which is
    // exactly the half-answer that undercounted the badge.
    const { store, sessions, status } = harness();
    conversation(store, 'brain-1-a');
    store.beginSessionActivity('brain-1-a', 'turn-a', 'web');
    store.settleSessionActivity('brain-1-a', 'turn-a', 'web', 'done');
    sessions.setChildRunning('brain-1-a', 'brain-ch-subagent-sub-dlg-1', true);

    expect(status.listSessions(OWNER).find((s) => s.id === 'brain-1-a')?.working).toBe(true);
  });

  it('reports two working parents as two, not as the number of children they are waiting on', () => {
    const { store, sessions, status } = harness();
    conversation(store, 'brain-1-a');
    conversation(store, 'brain-1-b');
    store.beginSessionActivity('brain-1-a', 'turn-a', 'web');
    store.beginSessionActivity('brain-1-b', 'turn-b', 'web');
    // Both children are mid-TOOL-call, so neither is streaming — the state the old badge could not see.
    sessions.setChildRunning('brain-1-a', 'brain-ch-subagent-sub-dlg-a', true);
    sessions.setChildRunning('brain-1-b', 'brain-ch-subagent-sub-dlg-b1', true);
    sessions.setChildRunning('brain-1-b', 'brain-ch-subagent-sub-dlg-b2', true);

    expect(workingIds(status.listSessions(OWNER)).sort()).toEqual(['brain-1-a', 'brain-1-b']);
  });

  it('never lists a delegated child as a conversation of its own', () => {
    const { store, sessions, status } = harness();
    conversation(store, 'brain-1-a');
    conversation(store, 'brain-ch-subagent-sub-dlg-a');
    sessions.setChildRunning('brain-1-a', 'brain-ch-subagent-sub-dlg-a', true);
    store.beginSessionActivity('brain-ch-subagent-sub-dlg-a', 'turn-child', 'web');

    expect(status.listSessions(OWNER).map((s) => s.id)).toEqual(['brain-1-a']);
  });

  it('keeps another account\'s working conversation out of the caller\'s list', () => {
    const { store, sessions, status } = harness();
    conversation(store, 'brain-2-a', OTHER);
    store.beginSessionActivity('brain-2-a', 'turn-a', 'web');
    sessions.setChildRunning('brain-2-a', 'brain-ch-subagent-sub-dlg-a', true);

    expect(status.listSessions(OWNER)).toEqual([]);
    expect(workingIds(status.listSessions(OTHER))).toEqual(['brain-2-a']);
  });

  it('settles back to idle when the turn finishes and the last child is released', () => {
    const { store, sessions, status } = harness();
    conversation(store, 'brain-1-a');
    store.beginSessionActivity('brain-1-a', 'turn-a', 'web');
    sessions.setChildRunning('brain-1-a', 'brain-ch-subagent-sub-dlg-a', true);
    store.settleSessionActivity('brain-1-a', 'turn-a', 'web', 'done');
    expect(workingIds(status.listSessions(OWNER))).toEqual(['brain-1-a']);

    sessions.setChildRunning('brain-1-a', 'brain-ch-subagent-sub-dlg-a', false);
    expect(workingIds(status.listSessions(OWNER))).toEqual([]);
  });

  it('does not read a live session object as work: `running` outlives the turn, `working` does not', () => {
    const { store, sessions, status } = harness();
    conversation(store, 'brain-1-a');
    sessions.set('brain-1-a', {
      sessionId: 'brain-1-a',
      session: { dispose: () => {}, isStreaming: false },
    } as unknown as LiveBrain);

    const row = status.listSessions(OWNER).find((s) => s.id === 'brain-1-a');
    expect(row?.running).toBe(true);
    expect(row?.working).toBe(false);
  });

  it('drops a stale working claim reaped at boot, so a restart leaves no phantom count', () => {
    const { store, status } = harness();
    conversation(store, 'brain-1-a');
    store.setDelegationBootId('boot-one');
    store.beginSessionActivity('brain-1-a', 'turn-a', 'web');
    expect(workingIds(status.listSessions(OWNER))).toEqual(['brain-1-a']);

    store.setDelegationBootId('boot-two');
    store.reconcileSessionActivityOnBoot();
    expect(workingIds(status.listSessions(OWNER))).toEqual([]);
  });
});
