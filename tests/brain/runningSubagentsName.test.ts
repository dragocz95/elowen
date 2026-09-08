import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { BrainStore } from '../../src/store/brainStore.js';
import { LiveSessionRegistry } from '../../src/brain/session/liveRegistry.js';
import { recordSubagentProgress } from '../../src/brain/subagentRuns.js';
import { runningSubagentsBlock } from '../../src/brain/session/runningSubagents.js';
import type { BrainEvent, SubagentUpdate } from '../../src/brain/events.js';
import type { LiveBrain } from '../../src/brain/session/liveBrain.js';

const PARENT = 'brain-1';
const CHILD = 'brain-ch-subagent-sub-dlg-named';
const CALL = 'call-delegate';

function harness() {
  const db = openDb(':memory:');
  const store = new BrainStore(db);
  const sessions = new LiveSessionRegistry<LiveBrain>();
  store.createSession({ id: PARENT, userId: 1, model: 'm' });
  store.createSession({
    id: CHILD,
    userId: 1,
    model: 'm',
    parentSessionId: PARENT,
    delegatedAccess: { admin: true, owner: true, projectIds: [], permissionBoundary: null },
  });
  const events: BrainEvent[] = [];
  const emit = (update: SubagentUpdate): boolean => recordSubagentProgress({
    store,
    claims: sessions,
    sessionId: PARENT,
    publish: (event) => { events.push(event); },
  }, update);
  sessions.setChildRunning(PARENT, CHILD, true);
  return { store, sessions, emit, events };
}

const running = (over: Partial<SubagentUpdate> = {}): SubagentUpdate => ({
  id: CALL, sessionId: CHILD, status: 'running', task: 'redesign the panel', tools: 3, seconds: 40, ...over,
});

/** The reminder is what lets a parent address a child it delegated — and until now the only handle it
 *  carried was the child's session id, which is a UUID nobody says out loud. The delegation's short name
 *  belongs here for that reason, and for that reason only: the child's live `detail` stays withheld, so
 *  the parent still cannot steer on the child's internal tool trace. */
describe('the running-subagents reminder names the child', () => {
  it('carries the delegation name as an attribute of the row', () => {
    const { store, sessions, emit } = harness();
    emit(running({ name: 'panel-redesign' }));

    const block = runningSubagentsBlock(sessions, store, PARENT);

    expect(block).toContain('name="panel-redesign"');
    expect(block).toContain('<task>redesign the panel</task>');
  });

  it('escapes a name, which is model-authored text on an XML attribute', () => {
    const { store, sessions, emit } = harness();
    emit(running({ name: 'a "quoted" & <angled> name' }));

    const block = runningSubagentsBlock(sessions, store, PARENT);

    expect(block).toContain('name="a &quot;quoted&quot; &amp; &lt;angled&gt; name"');
  });

  // The one thing that must not change: the reminder is a cached prompt prefix, so an unnamed run has to
  // render byte for byte what it did before the field existed.
  it('omits the attribute entirely for a run that carries no name', () => {
    const { store, sessions, emit } = harness();
    emit(running());

    const block = runningSubagentsBlock(sessions, store, PARENT);

    expect(block).not.toContain('name=');
    expect(block).toContain('<subagent session="brain-ch-subagent-sub-dlg-named" background="false"');
  });

  // Context hardening, unchanged: the name is a handle, the tool trace is not.
  it('still withholds the child\'s live tool detail', () => {
    const { store, sessions, emit } = harness();
    emit(running({ name: 'panel-redesign', detail: 'Edit /var/www/elowen/src/brain/events.ts' }));

    const block = runningSubagentsBlock(sessions, store, PARENT);

    expect(block).not.toContain('events.ts');
  });
});
