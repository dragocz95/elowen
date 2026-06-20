import { describe, it, expect, vi } from 'vitest';
import { run } from '../../src/cli/index.js';
import { OrcaClient } from '../../src/cli/client.js';

function fakeClient() {
  return {
    planSubmit: vi.fn().mockResolvedValue({}),
    overseerPoll: vi.fn().mockResolvedValue({ id: 'd1', kind: 'task', context: {} }),
    overseerDecide: vi.fn().mockResolvedValue({}),
  } as unknown as OrcaClient;
}

describe('cli reasoning verbs', () => {
  it('plan submit reads ORCA_PLAN_JOB and parses --phases JSON', async () => {
    const c = fakeClient();
    await run(['plan', 'submit', '--phases', '[{"title":"A","type":"task"}]'], c, { ORCA_PLAN_JOB: 'pj-7' });
    expect((c.planSubmit as any)).toHaveBeenCalledWith('pj-7', [{ title: 'A', type: 'task' }]);
  });
  it('overseer poll prints the next decision as JSON', async () => {
    const c = fakeClient();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['overseer', 'poll'], c, { ORCA_MISSION: 'm1' });
    expect((c.overseerPoll as any)).toHaveBeenCalledWith('m1');
    expect(log.mock.calls[0]![0]).toContain('"id": "d1"');
    log.mockRestore();
  });
  it('overseer decide maps --approve/--escalate and flags', async () => {
    const c = fakeClient();
    await run(['overseer', 'decide', '--id', 'd1', '--approve', '--confidence', '0.8', '--rationale', 'looks fine'], c, { ORCA_MISSION: 'm1' });
    expect((c.overseerDecide as any)).toHaveBeenCalledWith('m1', { id: 'd1', approve: true, confidence: 0.8, rationale: 'looks fine' });
    await run(['overseer', 'decide', '--id', 'd2', '--escalate', '--rationale', 'risky'], c, { ORCA_MISSION: 'm1' });
    expect((c.overseerDecide as any)).toHaveBeenLastCalledWith('m1', { id: 'd2', approve: false, confidence: 0, rationale: 'risky' });
  });
});
