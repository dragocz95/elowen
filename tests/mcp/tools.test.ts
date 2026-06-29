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

  it('orca_plan forwards all planning options to POST /tasks/plan', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_plan({
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
    });
    expect(calls[0].m).toBe('POST');
    expect(calls[0].p).toBe('/tasks/plan');
    expect(calls[0].b).toEqual({
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
    });
  });

  it('throws on a non-ok response so the agent sees the error', async () => {
    const { call } = spy({ status: 403, ok: false, data: { error: 'forbidden' }, text: 'forbidden' });
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await expect(tools.orca_tasks()).rejects.toThrow(/403/);
  });

  // ---- Notes ----
  it('orca_note_add maps to POST /notes', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_note_add({ target: 'epic-1', body: 'hello' });
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/notes', b: { scope: 'mission', target: 'epic-1', body: 'hello' } });
  });

  it('orca_notes maps to GET /notes with query', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_notes({ target: 'epic-1' });
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/notes?scope=mission&target=epic-1' });
  });

  // ---- Mission lifecycle ----
  it('orca_missions maps to GET /missions', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_missions();
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/missions' });
  });

  it('orca_mission_engage maps to POST /missions', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_mission_engage({ epicId: 'e-1', autonomy: 'L2', maxSessions: 3 });
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/missions', b: { epicId: 'e-1', autonomy: 'L2', maxSessions: 3 } });
  });

  it('orca_mission_pause maps to PATCH /missions/:id with action pause', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_mission_pause({ id: 'm-1' });
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/missions/m-1', b: { action: 'pause' } });
  });

  it('orca_mission_resume maps to PATCH /missions/:id with action resume', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_mission_resume({ id: 'm-1' });
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/missions/m-1', b: { action: 'resume' } });
  });

  it('orca_mission_disengage maps to DELETE /missions/:id', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_mission_disengage({ id: 'm-1' });
    expect(calls[0]).toMatchObject({ m: 'DELETE', p: '/missions/m-1' });
  });

  // ---- Session control ----
  it('orca_session_spawn maps to POST /sessions', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_session_spawn({ taskId: 't-1', exec: 'sonnet' });
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/sessions', b: { taskId: 't-1', exec: 'sonnet' } });
  });

  it('orca_session_kill maps to DELETE /sessions/:name', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_session_kill({ name: 'orca-t-1' });
    expect(calls[0]).toMatchObject({ m: 'DELETE', p: '/sessions/orca-t-1' });
  });

  it('orca_session_send_keys maps to POST /sessions/:name/keys', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_session_send_keys({ name: 'orca-t-1', keys: ['Enter'] });
    expect(calls[0]).toMatchObject({ m: 'POST', p: '/sessions/orca-t-1/keys', b: { keys: ['Enter'] } });
  });

  it('orca_session_read_pane maps to GET /sessions/:name/pane', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_session_read_pane({ name: 'orca-t-1' });
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/sessions/orca-t-1/pane' });
  });

  it('orca_session_read_pane with ansi=true adds ?ansi=1', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_session_read_pane({ name: 'orca-t-1', ansi: true });
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/sessions/orca-t-1/pane?ansi=1' });
  });

  // ---- Task lifecycle ----
  it('orca_task_update maps to PATCH /tasks/:id with only the passed fields', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_task_update({ id: 't-1', status: 'in_progress', title: 'new title' });
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/tasks/t-1', b: { status: 'in_progress', title: 'new title' } });
  });

  it('orca_task_close maps to PATCH /tasks/:id with status closed + outcome', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_task_close({ id: 't-1', result_summary: 'done', outcome: 'ok' });
    expect(calls[0]).toMatchObject({ m: 'PATCH', p: '/tasks/t-1', b: { status: 'closed', result_summary: 'done', outcome: 'ok' } });
  });

  it('orca_task_usage maps to GET /tasks/:id/usage', async () => {
    const { calls, call } = spy();
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    await tools.orca_task_usage({ id: 't-1' });
    expect(calls[0]).toMatchObject({ m: 'GET', p: '/tasks/t-1/usage' });
  });

  // ---- Non-ok throw for every tool ----
  it.each([
    'orca_note_add', 'orca_notes', 'orca_missions', 'orca_mission_engage',
    'orca_mission_pause', 'orca_mission_resume', 'orca_mission_disengage',
    'orca_session_spawn', 'orca_session_kill', 'orca_session_send_keys',
    'orca_session_read_pane', 'orca_task_update', 'orca_task_close', 'orca_task_usage',
  ] as const)('%s throws on non-ok response', async (toolName) => {
    const { call } = spy({ status: 500, ok: false, data: { error: 'boom' }, text: 'Internal Server Error' });
    const tools = makeOrcaTools({ url: 'http://d', token: 't', call: call as never });
    const args: Record<string, unknown> = {};
    if (toolName.startsWith('orca_note_') || toolName.startsWith('orca_mission_')) args.target = 'x';
    if (toolName.startsWith('orca_mission_')) args.epicId = 'x';
    if (toolName.startsWith('orca_session_')) args.name = 'x';
    if (toolName.startsWith('orca_task_')) args.id = 'x';
    if (toolName === 'orca_note_add') args.body = 'x';
    if (toolName === 'orca_session_send_keys') args.keys = ['x'];
    if (toolName === 'orca_session_spawn') args.taskId = 'x';
    if (toolName === 'orca_mission_engage') { args.epicId = 'x'; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((tools as any)[toolName](args)).rejects.toThrow(/500/);
  });
});
