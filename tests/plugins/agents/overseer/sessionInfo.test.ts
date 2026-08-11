import { describe, it, expect } from 'vitest';
import { classifySession } from '../../../../src/shared/sessionInfo.js';

describe('classifySession', () => {
  it('classifies a worker agent', () => {
    expect(classifySession('elowen-Patricita')).toEqual({ name: 'elowen-Patricita', role: 'agent', agent: 'Patricita' });
  });

  it('classifies the pilot/planner', () => {
    expect(classifySession('elowen-pilot-Nova')).toEqual({ name: 'elowen-pilot-Nova', role: 'pilot', agent: 'Nova' });
  });

  it('classifies the overseer and extracts its mission id', () => {
    expect(classifySession('elowen-overseer-m-elowen-240cff5c')).toEqual({
      name: 'elowen-overseer-m-elowen-240cff5c', role: 'overseer', agent: '', missionId: 'm-elowen-240cff5c',
    });
  });

  it('does not mistake an agent named with an overseer-like word for the overseer', () => {
    // Only the exact `pilot-`/`overseer-` prefixes switch role; a normal name is always an agent.
    expect(classifySession('elowen-Overlord').role).toBe('agent');
  });

  it('classifies an advisor session and extracts its user id', () => {
    expect(classifySession('elowen-advisor-7')).toEqual({ name: 'elowen-advisor-7', role: 'advisor', agent: '', userId: 7 });
  });

  it('leaves userId undefined for a malformed advisor name', () => {
    expect(classifySession('elowen-advisor-x').userId).toBeUndefined();
  });
});
