import { describe, it, expect } from 'vitest';
import { MODULES, NAVIGATION_WORLDS, navigationWorldForPath } from '../../modules/registry';

describe('module registry', () => {
  it('registers the eleven core modules with routes + groups', () => {
    // /sessions and /escalations are gone on purpose: those pages live in the agents plugin bundle
    // now (reachable at /p/agents/…); the old core routes survive only as redirects.
    expect(MODULES.map((m) => m.route)).toEqual(['/dash', '/stats', '/tasks', '/kanban', '/timeline', '/settings', '/projects', '/editor', '/users', '/memory', '/chat']);
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
      { id: 'projects', route: '/projects', children: ['/projects', '/editor'] },
      { id: 'memory', route: '/memory', children: [] },
    ]);
    expect(navigationWorldForPath('/chat')?.id).toBe('chat');
    expect(navigationWorldForPath('/kanban')?.id).toBe('work');
    expect(navigationWorldForPath('/editor')?.id).toBe('projects');
    expect(navigationWorldForPath('/escalations')).toBeUndefined();
    expect(navigationWorldForPath('/sessions')).toBeUndefined();
  });
});
