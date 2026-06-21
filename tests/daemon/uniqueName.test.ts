import { describe, it, expect } from 'vitest';
import { uniqueName, freeAgentName } from '../../src/daemon/uniqueName.js';

describe('uniqueName', () => {
  it('never returns the same name twice in a run', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uniqueName());
    expect(seen.size).toBe(1000);
  });
});

describe('freeAgentName', () => {
  it('returns the first generated name when nothing collides', async () => {
    const name = await freeAgentName(() => 'Nova', async () => []);
    expect(name).toBe('Nova');
  });

  it('skips a name whose live tmux session already exists (worker prefix)', async () => {
    const queue = ['Nova', 'Atlas'];
    const name = await freeAgentName(() => queue.shift()!, async () => ['orca-Nova']);
    expect(name).toBe('Atlas'); // orca-Nova is live → rolled to the next free name
  });

  it('honours the session prefix when checking liveness (pilot)', async () => {
    const queue = ['Nova', 'Atlas'];
    const name = await freeAgentName(() => queue.shift()!, async () => ['orca-pilot-Nova'], 'pilot-');
    expect(name).toBe('Atlas'); // orca-pilot-Nova is live → skip Nova
  });

  it('falls back to a unique suffix when every candidate name is taken', async () => {
    // make always yields the same taken name → liveness can never be satisfied by re-rolling.
    const name = await freeAgentName(() => 'Nova', async () => ['orca-Nova']);
    expect(name).not.toBe('Nova');
    expect(name.startsWith('Nova-')).toBe(true); // friendly base kept, uniqueness appended
  });
});
