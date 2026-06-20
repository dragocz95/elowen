import { describe, it, expect } from 'vitest';
import { classifySession } from '../../src/overseer/sessionInfo.js';

describe('classifySession', () => {
  it('classifies a worker agent', () => {
    expect(classifySession('orca-Patricita')).toEqual({ name: 'orca-Patricita', role: 'agent', agent: 'Patricita' });
  });

  it('classifies the pilot/planner', () => {
    expect(classifySession('orca-pilot-Nova')).toEqual({ name: 'orca-pilot-Nova', role: 'pilot', agent: 'Nova' });
  });

  it('classifies the overseer and extracts its mission id', () => {
    expect(classifySession('orca-overseer-m-orca-240cff5c')).toEqual({
      name: 'orca-overseer-m-orca-240cff5c', role: 'overseer', agent: '', missionId: 'm-orca-240cff5c',
    });
  });

  it('does not mistake an agent named with an overseer-like word for the overseer', () => {
    // Only the exact `pilot-`/`overseer-` prefixes switch role; a normal name is always an agent.
    expect(classifySession('orca-Overlord').role).toBe('agent');
  });
});
