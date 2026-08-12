import { describe, it, expect } from 'vitest';
import { AGENTS_MCP_TOOLS } from '../../../plugins/agents/src/mcpTools.js';
import type { PluginMcpRequest } from '../../../src/plugins/api.js';

/** The agents MCP tools are pure REST proxies — each maps its arguments onto exactly the plugin's
 *  root-mounted route (moved from core src/mcp/tools.ts with batch 3b, mappings unchanged). */
function spy() {
  const calls: { m: string; p: string; b: unknown }[] = [];
  const req: PluginMcpRequest = async (m, p, b) => { calls.push({ m, p, b }); return { ok: 1 }; };
  return { calls, req };
}

const tool = (name: string) => {
  const t = AGENTS_MCP_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`missing agents MCP tool ${name}`);
  return t;
};

describe('agents plugin MCP tools (REST-proxy mappings)', () => {
  it('elowen_sessions maps to GET /sessions', async () => {
    const { calls, req } = spy();
    await tool('elowen_sessions').run({}, req);
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/sessions' });
  });

  // ---- Notes ----
  it('elowen_note_add maps to POST /notes', async () => {
    const { calls, req } = spy();
    await tool('elowen_note_add').run({ target: 'epic-1', body: 'hello' }, req);
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/notes', b: { scope: 'mission', target: 'epic-1', body: 'hello' } });
  });

  it('elowen_notes maps to GET /notes with query', async () => {
    const { calls, req } = spy();
    await tool('elowen_notes').run({ target: 'epic-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/notes?scope=mission&target=epic-1' });
  });

  // ---- Mission lifecycle ----
  it('elowen_missions maps to GET /missions', async () => {
    const { calls, req } = spy();
    await tool('elowen_missions').run({}, req);
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/missions' });
  });

  it('elowen_mission_engage maps to POST /missions', async () => {
    const { calls, req } = spy();
    await tool('elowen_mission_engage').run({ epicId: 'e-1', autonomy: 'L2', maxSessions: 3 }, req);
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/missions', b: { epicId: 'e-1', autonomy: 'L2', maxSessions: 3 } });
  });

  it('elowen_mission_pause maps to PATCH /missions/:id with action pause', async () => {
    const { calls, req } = spy();
    await tool('elowen_mission_pause').run({ id: 'm-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/missions/m-1', b: { action: 'pause' } });
  });

  it('elowen_mission_resume maps to PATCH /missions/:id with action resume', async () => {
    const { calls, req } = spy();
    await tool('elowen_mission_resume').run({ id: 'm-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/missions/m-1', b: { action: 'resume' } });
  });

  it('elowen_mission_disengage maps to DELETE /missions/:id', async () => {
    const { calls, req } = spy();
    await tool('elowen_mission_disengage').run({ id: 'm-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'DELETE', p: '/missions/m-1' });
  });

  // ---- Session control ----
  it('elowen_session_spawn maps to POST /sessions', async () => {
    const { calls, req } = spy();
    await tool('elowen_session_spawn').run({ taskId: 't-1', exec: 'sonnet' }, req);
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/sessions', b: { taskId: 't-1', exec: 'sonnet' } });
  });

  it('elowen_session_kill maps to DELETE /sessions/:name', async () => {
    const { calls, req } = spy();
    await tool('elowen_session_kill').run({ name: 'elowen-t-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'DELETE', p: '/sessions/elowen-t-1' });
  });

  it('elowen_session_send_keys maps to POST /sessions/:name/keys', async () => {
    const { calls, req } = spy();
    await tool('elowen_session_send_keys').run({ name: 'elowen-t-1', keys: ['Enter'] }, req);
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/sessions/elowen-t-1/keys', b: { keys: ['Enter'] } });
  });

  it('elowen_session_read_pane maps to GET /sessions/:name/pane (ansi=true adds ?ansi=1)', async () => {
    const { calls, req } = spy();
    await tool('elowen_session_read_pane').run({ name: 'elowen-t-1' }, req);
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/sessions/elowen-t-1/pane' });
    await tool('elowen_session_read_pane').run({ name: 'elowen-t-1', ansi: true }, req);
    expect(calls[1]).toMatchObject({ m: 'GET', p: '/sessions/elowen-t-1/pane?ansi=1' });
  });
});
