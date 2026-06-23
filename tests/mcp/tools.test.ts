import { describe, it, expect } from 'vitest';
import { makeOrcaTools } from '../../src/mcp/tools.js';
import type { CallResult } from '../../src/shared/apiClient.js';

type Call = { m: string; p: string; b: unknown; url: string; token: string };

function spy(result: CallResult = { status: 200, ok: true, data: { ok: 1 }, text: '' }) {
  const calls: Call[] = [];
  const call = async (m: string, p: string, b: unknown, o: { url: string; token: string }): Promise<CallResult> => {
    calls.push({ m, p, b, url: o.url, token: o.token });
    return result;
  };
  return { calls, call };
}

describe('makeOrcaTools', () => {
  it('orca_request delegates to callOrcaApi with the connection url+token', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d:4400', token: 'usr', call: call as never });
    const out = await tools.orca_request({ method: 'POST', path: '/tasks', body: { title: 'x' } });
    expect(calls[0]).toEqual({ m: 'POST', p: '/tasks', b: { title: 'x' }, url: 'http://d:4400', token: 'usr' });
    expect(out).toEqual({ ok: 1 });
  });

  it('typed helpers are thin fixed-route wrappers with no own logic', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_tasks();
    await tools.orca_create_task({ title: 'x', project_id: 1 });
    await tools.orca_plan({ goal: 'g', project_id: 1 });
    await tools.orca_sessions();
    expect(calls.map((c) => `${c.m} ${c.p}`)).toEqual(['GET /tasks', 'POST /tasks', 'POST /tasks/plan', 'GET /sessions']);
    expect(calls[1].b).toEqual({ title: 'x', project_id: 1 });
  });

  it('throws on a non-ok response so the agent sees the error', async () => {
    const { call } = spy({ status: 403, ok: false, data: { error: 'forbidden' }, text: 'forbidden' });
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await expect(tools.orca_tasks()).rejects.toThrow(/403/);
  });
});
