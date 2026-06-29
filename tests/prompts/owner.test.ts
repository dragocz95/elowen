import { describe, it, expect } from 'vitest';
import { resolveOwnerId, type OwnerDeps } from '../../src/prompts/owner.js';

function deps(over: Partial<{ tasks: Record<string, { created_by: number | null; parent_id: string | null }>; missions: Record<string, { created_by: number | null }>; users: number[] }> = {}): OwnerDeps {
  const tasks = over.tasks ?? {};
  const missions = over.missions ?? {};
  const users = over.users ?? [1];
  return {
    tasks: { get: (id) => tasks[id] ?? null },
    missions: { get: (id) => missions[id] ?? null },
    users: { list: () => users.map((id) => ({ id })) },
  };
}

describe('resolveOwnerId', () => {
  it('prefers the advisor user above everything', () => {
    expect(resolveOwnerId(deps({ users: [9] }), { advisorUserId: 5, taskId: 't1' })).toBe(5);
  });

  it('uses a standalone task owner', () => {
    const d = deps({ tasks: { t1: { created_by: 7, parent_id: null } }, users: [1] });
    expect(resolveOwnerId(d, { taskId: 't1' })).toBe(7);
  });

  it('inherits a phase task owner from its mission', () => {
    const d = deps({
      tasks: { ph: { created_by: null, parent_id: 'epic1' } },
      missions: { 'm-epic1': { created_by: 4 } },
      users: [1],
    });
    expect(resolveOwnerId(d, { taskId: 'ph' })).toBe(4);
  });

  it('falls through to the plan job owner', () => {
    expect(resolveOwnerId(deps({ users: [1] }), { planJob: { createdBy: 3 } })).toBe(3);
  });

  it('falls back to the first (admin) user when nothing is attributed', () => {
    expect(resolveOwnerId(deps({ users: [2, 3] }), { taskId: 'missing' })).toBe(2);
  });

  it('returns null only when there are no users at all', () => {
    expect(resolveOwnerId(deps({ users: [] }), {})).toBeNull();
  });

  it('phase with no mission owner falls back to admin', () => {
    const d = deps({ tasks: { ph: { created_by: null, parent_id: 'epicX' } }, users: [1] });
    expect(resolveOwnerId(d, { taskId: 'ph' })).toBe(1);
  });
});
