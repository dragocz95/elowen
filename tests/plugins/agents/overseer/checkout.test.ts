import { describe, it, expect } from 'vitest';
import { checkoutOf, busySharedCheckouts } from '../../../../plugins/agents/src/overseer/checkout.js';

const projectPath = (id: number) => (id === 1 ? '/o' : '/p2');

describe('checkoutOf', () => {
  it('maps a standalone task to its shared project path', () => {
    expect(checkoutOf({ projectPath }, { project_id: 1, parent_id: null })).toBe('/o');
  });

  it('maps a PR-mission phase to its isolated worktree, else the shared path', () => {
    const worktreeFor = (mid: string) => (mid === 'm-epicA' ? '/wt/A' : null);
    expect(checkoutOf({ projectPath, worktreeFor }, { project_id: 1, parent_id: 'epicA' })).toBe('/wt/A');
    expect(checkoutOf({ projectPath, worktreeFor }, { project_id: 1, parent_id: 'epicB' })).toBe('/o'); // no worktree → shared
  });
});

describe('busySharedCheckouts', () => {
  it('lists shared checkouts occupied by in-progress tasks, excluding isolated worktrees', () => {
    const worktreeFor = (mid: string) => (mid === 'm-iso' ? '/wt/iso' : null);
    const busy = busySharedCheckouts({ projectPath, worktreeFor }, [
      { project_id: 1, parent_id: null },   // standalone in /o → shared
      { project_id: 2, parent_id: null },   // standalone in /p2 → shared
      { project_id: 1, parent_id: 'iso' },  // PR phase in its own worktree → NOT shared
    ]);
    expect([...busy].sort()).toEqual(['/o', '/p2']);
    expect(busy.has('/wt/iso')).toBe(false); // isolated worktree never marked busy
  });

  it('is empty when nothing is in progress', () => {
    expect(busySharedCheckouts({ projectPath }, []).size).toBe(0);
  });
});
