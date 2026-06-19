import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { ProjectStore } from '../../src/store/projectStore.js';
import { UserProjectStore } from '../../src/store/userProjectStore.js';

function setup() {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  const admin = users.create('admin', 'pw');   // lowest id → admin
  const bob = users.create('bob', 'pw');
  const projects = new ProjectStore(db);
  const a = projects.create({ slug: 'a', path: '/a' });
  const b = projects.create({ slug: 'b', path: '/b' });
  return { up: new UserProjectStore(db), admin, bob, a, b };
}

describe('UserProjectStore', () => {
  it('assigns and lists a user’s projects, idempotently', () => {
    const { up, bob, a, b } = setup();
    up.assign(bob.id, a.id);
    up.assign(bob.id, a.id); // duplicate ignored
    up.assign(bob.id, b.id);
    expect(up.forUser(bob.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('unassigns', () => {
    const { up, bob, a, b } = setup();
    up.assign(bob.id, a.id); up.assign(bob.id, b.id);
    up.unassign(bob.id, a.id);
    expect(up.forUser(bob.id)).toEqual([b.id]);
  });

  it('admin (lowest id) always has access and is flagged admin; others only when assigned', () => {
    const { up, admin, bob, a, b } = setup();
    expect(up.isAdmin(admin.id)).toBe(true);
    expect(up.isAdmin(bob.id)).toBe(false);
    expect(up.canAccess(admin.id, a.id)).toBe(true); // admin → all
    expect(up.canAccess(bob.id, a.id)).toBe(false);   // not assigned
    up.assign(bob.id, a.id);
    expect(up.canAccess(bob.id, a.id)).toBe(true);
    expect(up.canAccess(bob.id, b.id)).toBe(false);
  });
});
