import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { TaskStore } from '../../src/store/taskStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { EventBus } from '../../src/api/sse.js';
import { PushDispatcher, type PrInfoReader } from '../../src/push/pushDispatcher.js';
import type { PushSender } from '../../src/push/pushSender.js';
import type { PushPayload } from '../../src/push/messages.js';

interface Captured { userIds: number[]; payload: PushPayload }

function harness(prInfo?: PrInfoReader) {
  const db: Db = openDb(':memory:');
  const missions = new MissionStore(db);
  const tasks = new TaskStore(db);
  const users = new UserStore(db);
  const adminId = users.create('admin', 'pw').id;
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'orca','/o')").run();
  const sent: Captured[] = [];
  const sender = { sendToUsers: async (userIds: number[], payload: PushPayload) => { sent.push({ userIds, payload }); } } as unknown as PushSender;
  const dispatcher = new PushDispatcher({ missions, tasks, users, sender, missionGit: prInfo });
  const bus = new EventBus();
  dispatcher.subscribe(bus);
  return { db, missions, tasks, users, adminId, sent, bus };
}

describe('PushDispatcher', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(); });

  it('pushes a review payload on a rejection to the mission recipients', () => {
    h.tasks.create({ id: 'e1', project_id: 1, title: 'Epic', type: 'epic' });
    h.tasks.create({ id: 't1', project_id: 1, title: 'Build', parent_id: 'e1' });
    h.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    h.bus.publish({ type: 'review', missionId: 'm-e1', taskId: 't1', approve: false, rationale: 'nope' });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.payload.kind).toBe('review');
    expect(h.sent[0]!.userIds).toEqual([h.adminId]);
  });

  it('sends nothing when a review is approved', () => {
    h.tasks.create({ id: 'e1', project_id: 1, title: 'Epic', type: 'epic' });
    h.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    h.bus.publish({ type: 'review', missionId: 'm-e1', taskId: 't1', approve: true, rationale: 'ok' });
    expect(h.sent).toHaveLength(0);
  });

  it('maps a needs_input signal via the agent label to its mission', () => {
    h.tasks.create({ id: 'e1', project_id: 1, title: 'Epic', type: 'epic' });
    h.tasks.create({ id: 't1', project_id: 1, title: 'Phase', parent_id: 'e1', labels: ['agent:zoe'] });
    h.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    h.bus.publish({ type: 'signal', session: 'orca-zoe', signal: { type: 'needs_input', question: 'Run?', options: [], context: '' } });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.payload.kind).toBe('needs_input');
    expect(h.sent[0]!.payload.session).toBe('orca-zoe');
  });

  it('pushes a done payload with the PR url when a mission disengages', () => {
    const withPr = harness({ prInfo: () => ({ prUrl: 'https://gh/pr/9' }) });
    withPr.tasks.create({ id: 'e1', project_id: 1, title: 'Epic', type: 'epic' });
    withPr.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    withPr.bus.publish({ type: 'mission', missionId: 'm-e1', state: 'disengaged' });
    expect(withPr.sent).toHaveLength(1);
    expect(withPr.sent[0]!.payload.kind).toBe('done');
    expect(withPr.sent[0]!.payload.prUrl).toBe('https://gh/pr/9');
  });

  it('swallows a lookup that throws (never aborts the bus)', () => {
    // A review event whose task is missing must not throw; the bus stays alive.
    h.missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    expect(() => h.bus.publish({ type: 'review', missionId: 'm-e1', taskId: 'gone', approve: false, rationale: 'x' })).not.toThrow();
    // Unknown task title falls back to 'Fáze'; still a valid push to the admin.
    expect(h.sent).toHaveLength(1);
  });
});
