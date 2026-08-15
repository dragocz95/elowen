import { describe, it, expect } from 'vitest';
import { CORE_MCP_TOOLS, makeMcpRequest } from '../../src/mcp/tools.js';
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

/** The daemon's own MCP tools. The task tools moved to the work plugin and are exercised through the
 *  SAME shared request core (makeMcpRequest) beside it, in the plugin registry
 *  (tests/mcp-workTools.test.ts there) — what stays here is that request core and the generic escape
 *  hatch built on it. */
const tool = (name: string) => {
  const t = CORE_MCP_TOOLS.find((x) => x.name === name);
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

  it('makeMcpRequest throws on a non-ok response so the agent sees the error', async () => {
    const { call } = spy({ status: 403, ok: false, data: { error: 'forbidden' }, text: 'forbidden' });
    const req = makeMcpRequest({ url: 'http://d', token: 't', call: call as never });
    await expect(tool('elowen_request').run({ method: 'GET', path: '/tasks' }, req)).rejects.toThrow(/403/);
  });
});
