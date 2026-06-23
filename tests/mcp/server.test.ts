import { describe, it, expect } from 'vitest';
import { handleMcpRequest } from '../../src/mcp/server.js';

/** A minimal MCP `initialize` JSON-RPC request — enough to prove the server stands up, advertises the
 *  orca server, and responds without error. The tool layer itself is covered by tools.test.ts. */
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

describe('handleMcpRequest', () => {
  it('responds 200 to an initialize handshake and names the orca server', async () => {
    const res = await handleMcpRequest(initRequest(), { url: 'http://localhost:4400', token: 'tok' });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('orca');           // serverInfo.name
    expect(body).toContain('protocolVersion'); // a real initialize result
  });
});
