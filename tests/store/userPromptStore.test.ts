import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserPromptStore } from '../../src/store/userPromptStore.js';

let db: ReturnType<typeof openDb>;
let prompts: UserPromptStore;

beforeEach(() => {
  db = openDb(':memory:');
  prompts = new UserPromptStore(db);
});

describe('UserPromptStore', () => {
  it('returns null when a user has no override', () => {
    expect(prompts.get(1, 'worker')).toBeNull();
  });

  it('set then get round-trips', () => {
    prompts.set(1, 'worker', 'my worker prompt');
    expect(prompts.get(1, 'worker')).toBe('my worker prompt');
  });

  it('set on a conflicting (user, name) updates in place', () => {
    prompts.set(1, 'worker', 'v1');
    prompts.set(1, 'worker', 'v2');
    expect(prompts.get(1, 'worker')).toBe('v2');
    const count = (db.prepare('SELECT COUNT(*) c FROM user_prompts').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('getAll returns a name→content map for one user only', () => {
    prompts.set(1, 'worker', 'a');
    prompts.set(1, 'pilot', 'b');
    prompts.set(2, 'worker', 'other');
    expect(prompts.getAll(1)).toEqual({ worker: 'a', pilot: 'b' });
  });

  it('remove drops a single override', () => {
    prompts.set(1, 'worker', 'a');
    prompts.remove(1, 'worker');
    expect(prompts.get(1, 'worker')).toBeNull();
  });

  it('deleting a user cascades away their prompt overrides', () => {
    const users = new UserStore(db);
    const u = users.create('alice', 'pw');
    prompts.set(u.id, 'worker', 'a');
    users.delete(u.id);
    expect(prompts.getAll(u.id)).toEqual({});
  });
});
