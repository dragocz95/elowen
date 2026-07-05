// A real (SDK-backed) MCP stdio server used by tests/plugins/mcpPlugin.test.ts. It exposes one `echo`
// tool and — to exercise orphan cleanup — spawns a long-lived grandchild in its own process group,
// writing that grandchild's pid to $GRANDCHILD_PID_FILE. Killing the server's process group must reap
// the grandchild too.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const pidFile = process.env.GRANDCHILD_PID_FILE;
if (pidFile) {
  // A grandchild that would outlive a naive child.kill() on the server — the group-kill must reap it.
  const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100000)'], { stdio: 'ignore' });
  writeFileSync(pidFile, String(gc.pid));
}

const server = new McpServer({ name: 'mock-mcp', version: '0.0.1' });
server.registerTool('echo', { description: 'Echo the text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));

await server.connect(new StdioServerTransport());
