import { describe, it, expect, vi } from 'vitest';
import { run } from '../../src/cli/index.js';
import { ElowenClient } from '../../src/cli/client.js';

function fakeClient() {
  return {
    planSubmit: vi.fn().mockResolvedValue({}),
    overseerPoll: vi.fn().mockResolvedValue({ id: 'd1', kind: 'task', context: {} }),
    overseerDecide: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue({}),
    sendInput: vi.fn().mockResolvedValue({}),
  } as unknown as ElowenClient;
}

describe('cli reasoning verbs', () => {
  it('plan submit reads ELOWEN_PLAN_JOB and parses --phases JSON', async () => {
    const c = fakeClient();
    await run(['plan', 'submit', '--phases', '[{"title":"A","type":"task"}]'], c, { ELOWEN_PLAN_JOB: 'pj-7' });
    expect((c.planSubmit as any)).toHaveBeenCalledWith('pj-7', [{ title: 'A', type: 'task' }]);
  });
  it('overseer poll prints the next decision as JSON', async () => {
    const c = fakeClient();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['overseer', 'poll'], c, { ELOWEN_MISSION: 'm1' });
    expect((c.overseerPoll as any)).toHaveBeenCalledWith('m1');
    expect(log.mock.calls[0]![0]).toContain('"id": "d1"');
    log.mockRestore();
  });
  it('close passes through a valid --outcome', async () => {
    const c = fakeClient();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['close', 'elowen-1', '--summary', 'done', '--outcome', 'ok'], c, {});
    expect((c.close as any)).toHaveBeenCalledWith('elowen-1', { summary: 'done', outcome: 'ok' });
    vi.restoreAllMocks();
  });
  it('close rejects an invalid --outcome with exit code 2 (no silent null)', async () => {
    const c = fakeClient();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(run(['close', 'elowen-1', '--outcome', 'success'], c, {})).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(2);
    expect((c.close as any)).not.toHaveBeenCalled();
    err.mockRestore(); exit.mockRestore();
  });
  it('send appends a newline by default so the message is submitted', async () => {
    const c = fakeClient();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['send', 'elowen-Nova', 'use variant B'], c, {});
    expect((c.sendInput as any)).toHaveBeenCalledWith('elowen-Nova', 'use variant B\n');
    vi.restoreAllMocks();
  });
  it('send --no-enter types the text without submitting', async () => {
    const c = fakeClient();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['send', 'elowen-Nova', 'draft text', '--no-enter'], c, {});
    expect((c.sendInput as any)).toHaveBeenCalledWith('elowen-Nova', 'draft text');
    vi.restoreAllMocks();
  });
  it('send without a message errors out and sends nothing', async () => {
    const c = fakeClient();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    await expect(run(['send', 'elowen-Nova'], c, {})).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect((c.sendInput as any)).not.toHaveBeenCalled();
    err.mockRestore(); exit.mockRestore();
  });
  it('overseer decide maps --approve/--escalate and flags', async () => {
    const c = fakeClient();
    await run(['overseer', 'decide', '--id', 'd1', '--approve', '--confidence', '0.8', '--rationale', 'looks fine'], c, { ELOWEN_MISSION: 'm1' });
    expect((c.overseerDecide as any)).toHaveBeenCalledWith('m1', { id: 'd1', approve: true, confidence: 0.8, rationale: 'looks fine' });
    await run(['overseer', 'decide', '--id', 'd2', '--escalate', '--rationale', 'risky'], c, { ELOWEN_MISSION: 'm1' });
    expect((c.overseerDecide as any)).toHaveBeenLastCalledWith('m1', { id: 'd2', approve: false, confidence: 0, rationale: 'risky' });
  });
});
