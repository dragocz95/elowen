// A real (SDK-backed) MCP stdio server that exposes RESOURCES rather than tools, so the resource tools'
// result shape can be tested against a server that actually answers resources/list and resources/read.
// One resource is text, the other is a binary blob, which is the branch that has to reach disk.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'mock-mcp-resources', version: '0.0.1' });

// The bridge lists tools as part of connecting, and a server with none answers that with -32601, which
// fails the whole connect. One trivial tool keeps this server reachable so its RESOURCES can be read.
server.registerTool('ping', { description: 'Answer pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));

server.registerResource(
  'notes',
  'file:///notes.txt',
  { description: 'Some notes', mimeType: 'text/plain' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'note body' }] }),
);

server.registerResource(
  'blob',
  'file:///picture.png',
  { mimeType: 'image/png' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: Buffer.from('binary-bytes').toString('base64') }] }),
);

await server.connect(new StdioServerTransport());
