import { describe, it, expect } from 'vitest';
import { sweepFinishedSessions } from '../../../../plugins/agents/src/overseer/janitor.js';
import { FakeTmuxDriver } from '../../../../src/tmux/fakeDriver.js';

describe('sweepFinishedSessions', () => {
  it('kills elowen- sessions whose task is closed/cancelled, keeps the rest', async () => {
    const tmux = new FakeTmuxDriver();
    await tmux.spawn('elowen-Done', { cwd: '/o', command: 'x' });
    await tmux.spawn('elowen-Running', { cwd: '/o', command: 'x' });
    await tmux.spawn('elowen-Unknown', { cwd: '/o', command: 'x' });
    await tmux.spawn('jat-Other', { cwd: '/o', command: 'x' }); // foreign — never touched
    const statuses: Record<string, string> = { 'elowen-Done': 'closed', 'elowen-Running': 'in_progress' };
    const reaped = await sweepFinishedSessions({
      tmux,
      taskForSession: (s) => { const name = s.replace(/^elowen-/, ''); const st = statuses[`elowen-${name}`]; return st ? { status: st as never } : null; },
    });
    expect(reaped).toEqual(['elowen-Done']);
    const live = await tmux.list();
    expect(live).toContain('elowen-Running'); // in-progress kept
    expect(live).toContain('elowen-Unknown'); // no task → kept (don't reap unknown)
    expect(live).toContain('jat-Other');    // foreign kept
    expect(live).not.toContain('elowen-Done');
  });
});
