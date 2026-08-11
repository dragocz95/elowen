import { describe, it, expect } from 'vitest';
import { openDb } from '../../../src/store/db.js';
import { makePluginDb } from '../../../src/store/pluginDb.js';
import { AGENTS_MIGRATIONS } from '../../../plugins/agents/src/store/migrations.js';
import { AgentStore } from '../../../plugins/agents/src/store/agentStore.js';
import { MissionStore } from '../../../plugins/agents/src/store/missionStore.js';
import { MissionPrStore } from '../../../plugins/agents/src/store/missionPrStore.js';
import { NoteStore } from '../../../plugins/agents/src/store/noteStore.js';

/** A DB as the agents plugin sees it: the shared main database through ctx.db(). */
function pluginDb() {
  const db = openDb(':memory:');
  return makePluginDb(db, 'agents', { canMigrate: true });
}

describe('agents plugin store layer (extraction step 3)', () => {
  it('migration v1 is self-sufficient: recreates the grandfathered tables when core no longer ships them', () => {
    const pdb = pluginDb();
    // Simulate the post-extraction world (step 8): core schema no longer carries these tables.
    for (const t of ['agents', 'missions', 'mission_pr', 'notes']) pdb.exec(`DROP TABLE ${t}`);
    pdb.migrate(AGENTS_MIGRATIONS);
    expect(pdb.appliedVersion()).toBe(1);
    const names = pdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','missions','mission_pr','notes') ORDER BY name").all() as { name: string }[];
    expect(names.map((r) => r.name)).toEqual(['agents', 'mission_pr', 'missions', 'notes']);
    // …and against a live pre-extraction DB (tables already exist) it must be a harmless no-op.
    const fresh = pluginDb();
    fresh.migrate(AGENTS_MIGRATIONS);
    expect(fresh.appliedVersion()).toBe(1);
  });

  it('AgentStore: upsert recycles a name onto a new program/model and resolves latest program/project', () => {
    const s = new AgentStore(pluginDb());
    s.upsert({ project_id: 1, name: 'Nova', program: 'opencode', model: 'gpt' });
    const recycled = s.upsert({ project_id: 1, name: 'Nova', program: 'claude', model: 'opus' });
    expect(recycled).toMatchObject({ project_id: 1, name: 'Nova', program: 'claude', model: 'opus' });
    expect(s.programFor('nova')).toBe('claude'); // COLLATE NOCASE
    expect(s.projectFor('Nova')).toBe(1);
    expect(s.programFor('ghost')).toBeNull();
  });

  it('MissionStore: engage is idempotent and re-engage reactivates without stealing ownership', () => {
    const s = new MissionStore(pluginDb());
    const m = s.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'auto', max_sessions: 2, created_by: 7 });
    expect(m.state).toBe('active');
    s.setState('m-e1', 'disengaged');
    const re = s.create({ id: 'm-e1', epic_id: 'e1', autonomy: 'guarded', max_sessions: 3, created_by: 9 });
    expect(re.state).toBe('active');
    expect(re.autonomy).toBe('guarded');
    expect(re.created_by).toBe(7); // original engager stays the owner
    expect(s.activeForEpic('e1')?.id).toBe('m-e1');
    s.setState('m-e1', 'stalled');
    expect(s.active()).toHaveLength(0);
    expect(s.live().map((x) => x.id)).toEqual(['m-e1']); // stalled stays in the tick loop
  });

  it('MissionPrStore: create never rebinds a live worktree; fix rounds bump and reset', () => {
    const s = new MissionPrStore(pluginDb());
    s.create({ mission_id: 'm-e1', branch: 'b1', worktree: '/wt1' });
    const kept = s.create({ mission_id: 'm-e1', branch: 'b2', worktree: '/wt2' });
    expect(kept).toMatchObject({ branch: 'b1', worktree: '/wt1' }); // idempotent, original kept
    s.setPr('m-e1', { number: 5, url: 'u', state: 'open' });
    expect(s.withOpenPr()).toHaveLength(1);
    expect(s.bumpFixRounds('m-e1')).toBe(1);
    s.setLastFeedback('m-e1', 'fix the tests');
    s.resetFixRounds('m-e1');
    expect(s.get('m-e1')).toMatchObject({ fix_rounds: 0, last_feedback: null });
    s.setPrState('m-e1', 'merged');
    expect(s.pending()).toHaveLength(0);
  });

  it('NoteStore: chronological handoff log with scoped and global purges', () => {
    const s = new NoteStore(pluginDb());
    s.add({ scope: 'mission', target: 'e1', body: 'first' });
    s.add({ scope: 'mission', target: 'e1', author: 'nova', body: 'second' });
    s.add({ scope: 'other', target: 'e1', body: 'elsewhere' });
    expect(s.list('mission', 'e1').map((n) => n.body)).toEqual(['first', 'second']);
    expect(s.count('mission', 'e1')).toBe(2);
    s.deleteForTarget('mission', 'e1');
    expect(s.count('mission', 'e1')).toBe(0);
    expect(s.count('other', 'e1')).toBe(1);
    s.add({ scope: 'mission', target: 'e1', body: 'again' });
    s.deleteAllForTarget('e1'); // epic delete: no orphan notes under ANY scope
    expect(s.count('other', 'e1')).toBe(0);
    expect(s.count('mission', 'e1')).toBe(0);
  });
});
