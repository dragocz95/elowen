import { describe, it, expect } from 'vitest';
import { sweepFinishedSessions } from '../../src/overseer/janitor.js';
import { FakeTmuxDriver } from '../../src/tmux/fakeDriver.js';

describe('sweepFinishedSessions', () => {
  it('kills orca- sessions whose task is closed/cancelled, keeps the rest', async () => {
    const tmux = new FakeTmuxDriver();
    await tmux.spawn('orca-Done', { cwd: '/o', command: 'x' });
    await tmux.spawn('orca-Running', { cwd: '/o', command: 'x' });
    await tmux.spawn('orca-Unknown', { cwd: '/o', command: 'x' });
    await tmux.spawn('jat-Other', { cwd: '/o', command: 'x' }); // foreign — never touched
    const statuses: Record<string, string> = { 'orca-Done': 'closed', 'orca-Running': 'in_progress' };
    const reaped = await sweepFinishedSessions({
      tmux,
      taskForSession: (s) => { const name = s.replace(/^orca-/, ''); const st = statuses[`orca-${name}`]; return st ? { status: st } : null; },
    });
    expect(reaped).toEqual(['orca-Done']);
    const live = await tmux.list();
    expect(live).toContain('orca-Running'); // in-progress kept
    expect(live).toContain('orca-Unknown'); // no task → kept (don't reap unknown)
    expect(live).toContain('jat-Other');    // foreign kept
    expect(live).not.toContain('orca-Done');
  });
});
