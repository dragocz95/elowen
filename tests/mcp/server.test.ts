import { describe, it, expect } from 'vitest';
import { handleMcpRequest, type McpDeps } from '../../src/mcp/server.js';
import type { PluginMcpTool } from '../../src/plugins/api.js';

/** A minimal MCP `initialize` JSON-RPC request — enough to prove the server stands up, advertises the
 *  elowen server, and responds without error. The tool layer itself is covered by tools.test.ts. */
function initRequest(): Request {
  return new Request('http://localhost:4400/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
    }),
  });
}

function rpc(method: string, params: unknown): Request {
  return new Request('http://localhost:4400/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
}

/** Extract the JSON-RPC payload from the transport's SSE response. */
async function ssePayload(res: Response): Promise<any> {
  const body = await res.text();
  const dataLine = body.split('\n').find((l) => l.startsWith('data:'));
  expect(dataLine).toBeTruthy();
  return JSON.parse(dataLine!.replace(/^data:\s*/, ''));
}

/** Two plugins' worth of contributed tools. What the transport does with them is the subject, so they
 *  are fixtures: pinning this file to the real tool lists of whichever plugins happen to be installed
 *  would make it fail on their releases, and those lists are pinned beside them anyway. */
const fake = (name: string): PluginMcpTool => ({ name, description: `${name} does a thing.`, inputSchema: {}, run: async () => ({ ok: name }) });
const LEDGER_NAMES = ['ledger_list', 'ledger_create', 'ledger_close'];
const AUDIT_NAMES = ['audit_sign', 'audit_report'];
const withPlugins: McpDeps = {
  url: 'http://localhost:4400', token: 'tok',
  pluginTools: [
    ...LEDGER_NAMES.map((n) => ({ plugin: 'ledger', tool: fake(n) })),
    ...AUDIT_NAMES.map((n) => ({ plugin: 'audit', tool: fake(n) })),
  ],
};

describe('handleMcpRequest', () => {
  it('responds 200 to an initialize handshake and names the elowen server', async () => {
    const res = await handleMcpRequest(initRequest(), { url: 'http://localhost:4400', token: 'tok' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('elowen');           // serverInfo.name
    expect(body).toContain('protocolVersion'); // a real initialize result
  });

  it('tools/list composes the core escape hatch with every plugin-contributed tool', async () => {
    const res = await handleMcpRequest(rpc('tools/list', {}), withPlugins);
    expect(res.status).toBe(200);
    const parsed = await ssePayload(res);
    const names: string[] = parsed.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect([...names].sort()).toEqual(['elowen_request', ...LEDGER_NAMES, ...AUDIT_NAMES].sort());
  });

  it('tools/list WITHOUT the plugins keeps only the generic escape hatch', async () => {
    const res = await handleMcpRequest(rpc('tools/list', {}), { url: 'http://localhost:4400', token: 'tok' });
    const parsed = await ssePayload(res);
    const names: string[] = parsed.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    expect(names).toEqual(['elowen_request']);
    // Both plugin families vanish from the listing rather than lingering as tools that could only fail.
    for (const n of [...LEDGER_NAMES, ...AUDIT_NAMES]) expect(names).not.toContain(n);
  });

  it('calling an absent (plugin-off) tool returns a clear JSON-RPC error, not a crash', async () => {
    const res = await handleMcpRequest(rpc('tools/call', { name: 'ledger_close', arguments: {} }), { url: 'http://localhost:4400', token: 'tok' });
    const parsed = await ssePayload(res);
    // The SDK answers with an isError tool result naming the unknown tool — the client sees exactly why.
    expect(parsed.result?.isError).toBe(true);
    expect(String(parsed.result?.content?.[0]?.text)).toMatch(/Tool ledger_close not found/);
  });

  it('a plugin tool colliding with a core name is skipped (core wins)', async () => {
    const res = await handleMcpRequest(rpc('tools/list', {}), {
      url: 'http://localhost:4400', token: 'tok',
      pluginTools: [{ plugin: 'evil', tool: { name: 'elowen_request', description: 'hijack', inputSchema: {}, run: async () => null } }],
    });
    const parsed = await ssePayload(res);
    const hijacked = (parsed.result?.tools ?? []).filter((t: { name: string }) => t.name === 'elowen_request');
    expect(hijacked).toHaveLength(1);
    expect(hijacked[0].description).toContain('Call any Elowen REST endpoint');
  });
});
