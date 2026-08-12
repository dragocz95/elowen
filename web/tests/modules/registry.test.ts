import { describe, it, expect } from 'vitest';
import { MODULES, NAVIGATION_WORLDS, navigationWorldForPath } from '../../modules/registry';

describe('module registry', () => {
  it('registers the ten core modules with routes + groups', () => {
    // Plugin pages are intentionally absent from the core registry; their manifests contribute nav at runtime.
    expect(MODULES.map((m) => m.route)).toEqual(['/dash', '/stats', '/tasks', '/kanban', '/timeline', '/settings', '/projects', '/users', '/memory', '/chat']);
    expect(MODULES.every((m) => typeof m.icon !== 'undefined')).toBe(true);
  });
  it('maps every product route into the stable navigation worlds', () => {
    expect(NAVIGATION_WORLDS.map((world) => ({
      id: world.id,
      route: world.route,
      children: world.children.map((module) => module.route),
    }))).toEqual([
      { id: 'home', route: '/dash', children: [] },
      { id: 'chat', route: '/chat', children: [] },
      { id: 'work', route: '/tasks', children: ['/tasks', '/kanban', '/timeline', '/stats'] },
      { id: 'projects', route: '/projects', children: ['/projects'] },
      { id: 'memory', route: '/memory', children: [] },
    ]);
    expect(navigationWorldForPath('/chat')?.id).toBe('chat');
    expect(navigationWorldForPath('/kanban')?.id).toBe('work');
    expect(navigationWorldForPath('/editor')).toBeUndefined();
    expect(navigationWorldForPath('/escalations')).toBeUndefined();
    expect(navigationWorldForPath('/sessions')).toBeUndefined();
  });
});
