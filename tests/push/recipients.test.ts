import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import type { Db } from '../../src/store/db.js';
import { MissionStore } from '../../src/store/missionStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { recipientsForMission } from '../../src/push/recipients.js';

let db: Db; let missions: MissionStore; let users: UserStore;
let adminId: number; let ownerId: number;
beforeEach(() => {
  db = openDb(':memory:');
  missions = new MissionStore(db);
  users = new UserStore(db);
  adminId = users.create('admin', 'pw').id; // first user → admin
  ownerId = users.create('owner', 'pw').id;
});

describe('recipientsForMission', () => {
  it('notifies the owner plus every admin', () => {
    missions.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, created_by: ownerId });
    expect(recipientsForMission('m-e1', { missions, users }).sort()).toEqual([adminId, ownerId].sort());
  });

  it('falls back to admins only when the mission has no owner', () => {
    missions.create({ id: 'm-e2', epic_id: 'e2', autonomy: 'L3', max_sessions: 1 });
    expect(recipientsForMission('m-e2', { missions, users })).toEqual([adminId]);
  });

  it('returns admins (and no throw) for an unknown mission', () => {
    expect(recipientsForMission('m-nope', { missions, users })).toEqual([adminId]);
  });
});
