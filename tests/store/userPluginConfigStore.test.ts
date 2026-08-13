import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { UserStore } from '../../src/store/userStore.js';
import { UserPluginConfigStore } from '../../src/store/userPluginConfigStore.js';

function setup() {
  const db = openDb(':memory:');
  const users = new UserStore(db);
  return { db, users, store: new UserPluginConfigStore(db), amy: users.create('amy', 'pw'), ben: users.create('ben', 'pw') };
}

describe('UserPluginConfigStore', () => {
  it('keeps each account and each plugin apart', () => {
    const { store, amy, ben } = setup();
    store.set(amy.id, 'crm', { key: 'amy' });
    store.set(ben.id, 'crm', { key: 'ben' });
    store.set(amy.id, 'other', { key: 'amy-other' });
    expect(store.get(amy.id, 'crm')).toEqual({ key: 'amy' });
    expect(store.get(ben.id, 'crm')).toEqual({ key: 'ben' });
    expect(store.get(amy.id, 'other')).toEqual({ key: 'amy-other' });
    expect(store.get(ben.id, 'other')).toEqual({});
  });

  it('reads a corrupt or non-object blob as "nothing configured" rather than throwing', () => {
    const { db, store, amy } = setup();
    db.prepare('INSERT INTO user_plugin_config (user_id, plugin, data) VALUES (?, ?, ?)').run(amy.id, 'crm', '{not json');
    // A hand-edited database must not take down every turn that reads this plugin.
    expect(store.get(amy.id, 'crm')).toEqual({});
    db.prepare('UPDATE user_plugin_config SET data = ? WHERE user_id = ?').run('[1,2]', amy.id);
    expect(store.get(amy.id, 'crm')).toEqual({});
  });

  it('drops the row when the last value is cleared, so "empty" is one state and not two', () => {
    const { db, store, amy } = setup();
    store.set(amy.id, 'crm', { key: 'amy' });
    store.set(amy.id, 'crm', {});
    expect((db.prepare('SELECT COUNT(*) c FROM user_plugin_config').get() as { c: number }).c).toBe(0);
  });

  it('goes with the account when it is deleted', () => {
    const { users, store, amy, ben } = setup();
    store.set(amy.id, 'crm', { key: 'amy' });
    store.set(ben.id, 'crm', { key: 'ben' });
    users.delete(amy.id);
    expect(store.get(amy.id, 'crm')).toEqual({});
    expect(store.get(ben.id, 'crm')).toEqual({ key: 'ben' });
  });
});
