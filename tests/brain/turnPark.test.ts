import { describe, it, expect } from 'vitest';
import { TurnParkPolicy } from '../../src/brain/turnPark.js';

/** THE INVARIANT: a turn parks only where a boot resume exists (see turnPark.ts). */
describe('TurnParkPolicy — which live turns the pause may park', () => {
  it('parks an owner conversation unconditionally and writes the marker through the hook', () => {
    const marked: string[] = [];
    const policy = new TurnParkPolicy({ onParked: (id) => { marked.push(id); } });
    expect(policy.parkNow('brain-1-abc')).toBe(true);
    expect(marked).toEqual(['brain-1-abc']);
  });

  it('never parks a delegated sub-agent session: its run row is the resume', () => {
    const marked: string[] = [];
    const policy = new TurnParkPolicy({ onParked: (id) => { marked.push(id); }, parksPlatformTurn: () => true });
    expect(policy.parkNow('brain-ch-subagent-sub-dlg-1')).toBe(false);
    expect(marked).toEqual([]);
  });

  it('parks a platform channel turn only when the hook proves a faithful resume, and fails closed without one', () => {
    const marked: string[] = [];
    const eligible = new TurnParkPolicy({ onParked: (id) => { marked.push(id); }, parksPlatformTurn: (id) => id === 'brain-ch-discord-ops' });
    expect(eligible.parkNow('brain-ch-discord-ops')).toBe(true);
    expect(eligible.parkNow('brain-ch-cron-daily')).toBe(false);
    expect(marked).toEqual(['brain-ch-discord-ops']);
    // No hook wired ⇒ no platform turn ever parks (a task worker session, a minimal wiring).
    const bare = new TurnParkPolicy({ onParked: (id) => { marked.push(id); } });
    expect(bare.parkNow('brain-ch-discord-ops')).toBe(false);
    // A throwing hook is a refusal, never a crash of the pause.
    const throwing = new TurnParkPolicy({ onParked: (id) => { marked.push(id); }, parksPlatformTurn: () => { throw new Error('boom'); } });
    expect(throwing.parkNow('brain-ch-discord-ops')).toBe(false);
    expect(marked).toEqual(['brain-ch-discord-ops']);
  });
});
