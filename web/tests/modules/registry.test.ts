import { describe, it, expect } from 'vitest';
import { MODULES, modulesByGroup } from '../../modules/registry';

describe('module registry', () => {
  it('registers the five modules with routes + groups', () => {
    expect(MODULES.map((m) => m.route)).toEqual(['/dash', '/tasks', '/sessions', '/missions', '/settings']);
    expect(MODULES.every((m) => typeof m.icon !== 'undefined')).toBe(true);
  });
  it('groups Operate (4) and Config (1)', () => {
    const groups = modulesByGroup();
    expect(groups.find((g) => g.group === 'Operate')?.items.length).toBe(4);
    expect(groups.find((g) => g.group === 'Config')?.items.map((m) => m.route)).toEqual(['/settings']);
  });
});
