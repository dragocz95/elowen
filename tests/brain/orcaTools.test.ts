import { describe, it, expect, vi } from 'vitest';
import { buildOrcaTools } from '../../src/brain/tools/index.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe('buildOrcaTools', () => {
  it('exposes the expected tool names', () => {
    const names = buildOrcaTools({ url: 'http://x', token: 't' }).map((t) => t.name).sort();
    expect(names).toEqual([
      'orca_create_task', 'orca_list_missions', 'orca_list_sessions', 'orca_list_tasks', 'orca_plan',
    ]);
  });

  it('orca_create_task POSTs to /tasks and returns the created task text', async () => {
    const f = fakeFetch(200, { id: 'orca-1', title: 'Fix build' });
    const tool = buildOrcaTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'orca_create_task')!;
    const res = await tool.execute('call-1', { title: 'Fix build', project_id: 1 });
    expect(f).toHaveBeenCalledWith('http://x/tasks', expect.objectContaining({ method: 'POST' }));
    expect(res.content[0]!.text).toContain('orca-1');
  });

  it('orca_list_tasks GETs /tasks', async () => {
    const f = fakeFetch(200, [{ id: 'orca-1' }]);
    const tool = buildOrcaTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'orca_list_tasks')!;
    await tool.execute('call-2', {});
    expect(f).toHaveBeenCalledWith('http://x/tasks', expect.objectContaining({ method: 'GET' }));
  });

  it('surfaces API errors as text instead of throwing', async () => {
    const f = fakeFetch(500, { error: 'boom' });
    const tool = buildOrcaTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'orca_list_missions')!;
    const res = await tool.execute('call-3', {});
    expect(res.content[0]!.text).toContain('HTTP 500');
  });
});
