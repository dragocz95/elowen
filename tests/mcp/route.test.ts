import { describe, it, expect } from 'vitest';
import { TaskStore } from '../../plugins/work/src/store/taskStore.js';
import { Readiness } from '../../plugins/work/src/store/readiness.js';
import { MissionStore } from '../../plugins/agents/src/store/missionStore.js';
import { EventBus } from '../../src/api/sse.js';
import { createServer } from '../../src/api/server.js';
import { FakeClock } from '../../src/shared/clock.js';
import { ConfigStore } from '../../src/store/configStore.js';
import { UserStore } from '../../src/store/userStore.js';
import { openAgentsDb } from '../helpers/agentsDb.js';

function makeApp() {
  const db = openAgentsDb(':memory:');
  db.prepare("INSERT INTO projects (id,slug,path) VALUES (1,'elowen','/o')").run();
  const users = new UserStore(db);
  users.create('alice', 'secret');
  const app = createServer({
    tasks: new TaskStore(db), readiness: new Readiness(db), missions: new MissionStore(db),
    bus: new EventBus(), engine: null as any, spawn: null as any, tmux: null as any,
    project: { id: 1, path: '/o' }, fallback: { program: 'claude-code', model: 'sonnet' },
    clock: new FakeClock(0), config: new ConfigStore(db), users,
  });
  return { app, users };
}

function mcpInitBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
}

function mcpHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

describe('POST /mcp auth gating', () => {
  it('full-scope token completes an MCP initialize handshake and round-trips a tool call', async () => {
    const { app, users } = makeApp();
    const token = users.issueToken(users.list()[0]!.id);

    const initRes = await app.request('/mcp', {
      method: 'POST', headers: mcpHeaders(token), body: mcpInitBody(),
    });
    expect(initRes.status).toBe(200);
    const initBody = await initRes.text();
    expect(initBody).toContain('elowen');
    expect(initBody).toContain('protocolVersion');

    const toolsRes = await app.request('/mcp', {
      method: 'POST', headers: mcpHeaders(token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(toolsRes.status).toBe(200);
    const toolsBody = await toolsRes.text();
    // This app carries no plugin registry, so the listing is the core escape hatch alone — the task
    // tools ride the work plugin (see tests/api/mcpSurface.test.ts for the composed surface).
    expect(toolsBody).toContain('elowen_request');
    expect(toolsBody).not.toContain('elowen_tasks');
  });

  it('agent-scope service token gets 403 (not in agentAllowed)', async () => {
    const { app, users } = makeApp();
    const agentTok = users.ensureAgentToken(users.list()[0]!.id);
    const res = await app.request('/mcp', {
      method: 'POST', headers: mcpHeaders(agentTok), body: mcpInitBody(),
    });
    expect(res.status).toBe(403);
  });

  it('missing token gets 401', async () => {
    const { app } = makeApp();
    const res = await app.request('/mcp', {
      method: 'POST', headers: mcpHeaders(), body: mcpInitBody(),
    });
    expect(res.status).toBe(401);
  });

  it('invalid token gets 401', async () => {
    const { app } = makeApp();
    const res = await app.request('/mcp', {
      method: 'POST', headers: mcpHeaders('bogus-token'), body: mcpInitBody(),
    });
    expect(res.status).toBe(401);
  });
});
