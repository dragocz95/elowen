// A dependency-free MCP stdio server that can run INSIDE a project environment, where the SDK is not
// installed. One tool, `guest_probe`, reports facts only the guest can know (its hostname, its pid, and
// whether a file the test wrote through the managed file tools is visible), so a bridged call proves the
// server ran in the environment and not on the host. Framing is the MCP stdio contract: one JSON-RPC
// message per line.
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';

const TOOL = {
  name: 'guest_probe',
  description: 'Report where this MCP server is running',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const refuse = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // notifications need no answer
  switch (message.method) {
    case 'initialize':
      return reply(message.id, { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'guest-mcp', version: '0.0.1' } });
    case 'ping':
      return reply(message.id, {});
    case 'tools/list':
      return reply(message.id, { tools: [TOOL] });
    case 'tools/call': {
      if (message.params?.name !== TOOL.name) return refuse(message.id, -32602, 'unknown tool');
      const path = typeof message.params?.arguments?.path === 'string' ? message.params.arguments.path : '/workspace';
      const facts = { hostname: hostname(), pid: process.pid, cwd: process.cwd(), path, exists: existsSync(path), home: process.env.HOME ?? null };
      return reply(message.id, { content: [{ type: 'text', text: JSON.stringify(facts) }] });
    }
    default:
      return refuse(message.id, -32601, 'method not found');
  }
});
