import { describe, it, expect } from 'vitest';
import { CORE_MCP_TOOLS, makeMcpRequest } from '../../src/mcp/tools.js';
import { WORK_MCP_TOOLS } from '../../plugins/work/src/mcpTools.js';
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

// The task tools moved to the work plugin; they are still exercised through the SAME shared request
// core (makeMcpRequest), which is the point of the check.
const tool = (name: string) => {
  const t = [...CORE_MCP_TOOLS, ...WORK_MCP_TOOLS].find((x) => x.name === name);
  if (!t) throw new Error(`missing MCP tool ${name}`);
  return t;
};

describe('daemon MCP tools (REST proxies over makeMcpRequest)', () => {
  it('elowen_request delegates to callElowenApi with the connection url+token', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d:4400', token: 'usr', call: call as never });
    const out = await tool('elowen_request').run({ method: 'POST', path: '/tasks', body: { title: 'x' } }, req);
    expect(calls[0]).toEqual({ m: 'POST', p: '/tasks', b: { title: 'x' }, url: 'http://d:4400', token: 'usr' });
    expect(out).toEqual({ ok: 1 });
  });

  it('typed helpers are thin fixed-route wrappers with no own logic', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await tool('elowen_tasks').run({}, req);
    await tool('elowen_create_task').run({ title: 'x', project_id: 1 }, req);
    await tool('elowen_plan').run({ goal: 'g', project_id: 1 }, req);
    expect(calls.map((c) => `${c.m} ${c.p}`)).toEqual(['GET /tasks', 'POST /tasks', 'POST /tasks/plan']);
    expect(calls[1].b).toEqual({ title: 'x', project_id: 1 });
  });

  it('elowen_plan forwards all planning options to POST /tasks/plan', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    const args = {
      goal: 'build feature',
      project_id: 2,
      name: 'my-mission',
      exec: 'sonnet',
      autoModel: true,
      autonomy: 'L2',
      maxSessions: 3,
      engage: true,
      dryRun: false,
      prompt: 'custom prompt',
      prEnabled: true,
    };
    await tool('elowen_plan').run(args, req);
    expect(calls[0].m).toBe('POST');
    expect(calls[0].p).toBe('/tasks/plan');
    expect(calls[0].b).toEqual(args);
  });

  it('makeMcpRequest throws on a non-ok response so the agent sees the error', async () => {
    const { call } = spy({ status: 403, ok: false, data: { error: 'forbidden' }, text: 'forbidden' });
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await expect(tool('elowen_tasks').run({}, req)).rejects.toThrow(/403/);
  });

  // ---- Task lifecycle ----
  it('elowen_task_update maps to PATCH /tasks/:id with only the passed fields', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await tool('elowen_task_update').run({ id: 't-1', status: 'in_progress', title: 'new title' }, req);
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/tasks/t-1', b: { status: 'in_progress', title: 'new title' } });
  });

  it('elowen_task_close maps to PATCH /tasks/:id with status closed + outcome', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await tool('elowen_task_close').run({ id: 't-1', result_summary: 'done', outcome: 'ok' }, req);
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/tasks/t-1', b: { status: 'closed', result_summary: 'done', outcome: 'ok' } });
  });

  it('elowen_task_usage maps to GET /tasks/:id/usage', async () => {
    const { calls, call } = spy();
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await tool('elowen_task_usage').run({ id: 't-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/tasks/t-1/usage' });
  });
});
