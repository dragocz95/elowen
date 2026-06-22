import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/store/db.js';
import { MissionStore } from '../../src/store/missionStore.js';

let m: MissionStore;
beforeEach(() => { m = new MissionStore(openDb(':memory:')); });

describe('MissionStore', () => {
  it('persists a mission and lists it active; setState hides it', () => {
    m.create({ id: 'm1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    expect(m.active().map(x => x.id)).toEqual(['m1']);
    expect(m.get('m1')).toMatchObject({ id: 'm1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1, state: 'active' });
    m.setState('m1', 'disengaged');
    expect(m.active()).toEqual([]);
  });
  it('re-creating an existing mission id re-activates it instead of throwing (re-engage)', () => {
    m.create({ id: 'm1', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    m.setState('m1', 'disengaged'); // mission ran and was disengaged — the row stays behind
    // Re-engaging the same epic must not blow up on the UNIQUE id; it resets the row to active and
    // applies the new autonomy / max_sessions.
    const again = m.create({ id: 'm1', epic_id: 'e1', autonomy: 'L2', max_sessions: 3 });
    expect(again).toMatchObject({ id: 'm1', epic_id: 'e1', autonomy: 'L2', max_sessions: 3, state: 'active' });
    expect(m.active().map(x => x.id)).toEqual(['m1']); // active again, exactly one row
  });
  it('live includes active and stalled missions', () => {
    m.create({ id: 'a', epic_id: 'e1', autonomy: 'L3', max_sessions: 1 });
    m.create({ id: 'b', epic_id: 'e2', autonomy: 'L3', max_sessions: 1 });
    m.create({ id: 'c', epic_id: 'e3', autonomy: 'L3', max_sessions: 1 });
    m.setState('b', 'stalled');
    m.setState('c', 'paused');
    expect(m.live().map(x => x.id).sort()).toEqual(['a', 'b']); // paused excluded
  });
});
