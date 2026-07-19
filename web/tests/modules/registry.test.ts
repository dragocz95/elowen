import { describe, it, expect } from 'vitest';
import { MODULES, NAVIGATION_WORLDS, navigationWorldForPath, modulesByGroup } from '../../modules/registry';

describe('module registry', () => {
  it('registers the thirteen modules with routes + groups', () => {
    expect(MODULES.map((m) => m.route)).toEqual(['/dash', '/stats', '/tasks', '/kanban', '/timeline', '/escalations', '/sessions', '/settings', '/projects', '/editor', '/users', '/memory', '/chat']);
    expect(MODULES.every((m) => typeof m.icon !== 'undefined')).toBe(true);
  });
  it('groups Operate (11) and Config (2)', () => {
    const groups = modulesByGroup();
    expect(groups.find((g) => g.group === 'Operate')?.items.length).toBe(11); // missions folded into tasks; stats + escalations + projects + editor + memory + chat in Operate
    expect(groups.find((g) => g.group === 'Config')?.items.map((m) => m.route)).toEqual(['/settings', '/users']);
  });
  it('maps every product route into the stable navigation worlds', () => {
    expect(NAVIGATION_WORLDS.map((world) => ({
      id: world.id,
      route: world.route,
      children: world.children.map((module) => module.route),
    }))).toEqual([
      { id: 'home', route: '/dash', children: [] },
      { id: 'chat', route: '/chat', children: [] },
      { id: 'work', route: '/tasks', children: ['/tasks', '/kanban', '/sessions', '/timeline', '/stats'] },
      { id: 'projects', route: '/projects', children: ['/projects', '/editor'] },
      { id: 'memory', route: '/memory', children: [] },
    ]);
    expect(navigationWorldForPath('/chat')?.id).toBe('chat');
    expect(navigationWorldForPath('/kanban')?.id).toBe('work');
    expect(navigationWorldForPath('/editor')?.id).toBe('projects');
    expect(navigationWorldForPath('/escalations')).toBeUndefined();
  });
});
