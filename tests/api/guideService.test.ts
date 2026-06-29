import { describe, it, expect } from 'vitest';
import { createGuideService } from '../../src/api/services/guideService.js';

/** Minimal deps: a task store, a mission `active()` source, a users list (owner fallback). With no
 *  `prompts` the service renders the real `agent-guide*.md` files from disk — so these tests also guard
 *  the shipped template content. */
function setup(opts: { parentId?: string | null; activeEpics?: string[] } = {}) {
  const task = { id: 't1', created_by: null as number | null, parent_id: opts.parentId ?? null };
  const activeEpics = new Set(opts.activeEpics ?? []);
  const d = {
    cli: 'orca',
    tasks: { get: (id: string) => (id === 't1' ? task : null) },
    missions: { activeForEpic: (epicId: string) => (activeEpics.has(epicId) ? { id: `m-${epicId}`, epic_id: epicId } : null), get: () => null },
    users: { list: () => [{ id: 1 }] },
  } as never;
  return createGuideService(d);
}

describe('guideService', () => {
  it('renders the base control guide for a standalone task (no phase appendix)', () => {
    const text = setup().render('t1');
    expect(text).not.toBeNull();
    expect(text).toContain('First read the project context'); // base how-to-work
    expect(text).toContain('orca ask'); // the open-question channel, rendered with the resolved cli
    expect(text).toContain('orca close t1 --summary'); // the close command embeds this task's id
    expect(text).not.toContain('ONE phase of mission'); // no phase appendix for a standalone task
  });

  it('appends the mission-phase guide when the task is a phase of an ACTIVE mission', () => {
    const text = setup({ parentId: 'e1', activeEpics: ['e1'] }).render('t1');
    expect(text).toContain('ONE phase of mission e1');
    expect(text).toContain('orca note ls e1'); // handoff notes, with the epic id
    expect(text).toContain('orca close e1 --summary'); // the final phase closes the epic
    expect(text).toContain('do NOT run `git commit`'); // VCS is mission-managed
  });

  it('omits the phase appendix when the phase has no active mission', () => {
    const text = setup({ parentId: 'e1', activeEpics: [] }).render('t1');
    expect(text).not.toContain('ONE phase of mission');
  });

  it('returns null for an unknown task', () => {
    expect(setup().render('nope')).toBeNull();
  });

  it('renders through the owning user\'s prompt override (passes the resolved ownerId)', () => {
    const d = {
      cli: 'orca',
      tasks: { get: () => ({ id: 't1', created_by: 7, parent_id: null }) },
      missions: { active: () => [], get: () => null },
      users: { list: () => [{ id: 1 }] },
      // Stand-in PromptService: yields an override only for the task owner (user 7), else a default.
      prompts: { render: (name: string, vars: Record<string, string>, userId?: number | null) =>
        (userId === 7 && name === 'agent-guide' ? `OVERRIDDEN ${vars.closeCommand}` : `DEFAULT ${name}`) },
    } as never;
    expect(createGuideService(d).render('t1')).toBe('OVERRIDDEN orca close t1');
  });
});
