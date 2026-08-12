import { describe, it, expect, vi } from 'vitest';
import { buildWorkTools } from '../../../plugins/work/src/tools.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

/** A fetch mock that returns a different response per URL suffix (most-specific key wins). */
function routedFetch(routes: { suffix: string; status: number; body: unknown }[]): typeof fetch {
  const ordered = [...routes].sort((a, b) => b.suffix.length - a.suffix.length);
  return vi.fn(async (url: string) => {
    const r = ordered.find((x) => String(url).endsWith(x.suffix)) ?? { status: 404, body: { error: 'no route' } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}
const toolNamed = (f: typeof fetch, name: string) =>
  buildWorkTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === name)!;

describe('the work plugin\'s task tools', () => {
  it('exposes the expected tool names (the elowen control plane, nothing else)', () => {
    const names = buildWorkTools({ url: 'http://x', token: 't' }).map((t) => t.name).sort();
    // ElowenListMissions/ElowenListSessions moved to the agents plugin, the six Lsp* tools to the lsp
    // plugin — both registered via their manifests, so this group is the control plane alone.
    expect(names).toEqual([
      'ElowenCreateTask', 'ElowenGetTask', 'ElowenListTasks',
      'ElowenPlan', 'ElowenStopTask', 'ElowenTaskOutput', 'ElowenUpdateTask',
    ]);
  });

  it('ElowenCreateTask POSTs to /tasks and returns the created task text', async () => {
    const f = fakeFetch(200, { id: 'elowen-1', title: 'Fix build' });
    const tool = buildWorkTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'ElowenCreateTask')!;
    const res = await tool.execute('call-1', { title: 'Fix build', project_id: 1 });
    expect(f).toHaveBeenCalledWith('http://x/tasks', expect.objectContaining({ method: 'POST' }));
    expect(res.content[0]!.text).toContain('elowen-1');
  });

  it('ElowenListTasks GETs /tasks', async () => {
    const f = fakeFetch(200, [{ id: 'elowen-1' }]);
    const tool = buildWorkTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'ElowenListTasks')!;
    await tool.execute('call-2', {});
    expect(f).toHaveBeenCalledWith('http://x/tasks', expect.objectContaining({ method: 'GET' }));
  });

  // Without this tool the brain could open a task but never move it: create was write-only.
  describe('ElowenUpdateTask', () => {
    const updateTool = (f: typeof fetch) =>
      buildWorkTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'ElowenUpdateTask')!;

    it('PATCHes /tasks/:id with only the fields that were passed', async () => {
      const f = fakeFetch(200, { id: 'elowen-1', status: 'in_progress' });
      const res = await updateTool(f).execute('call-4', { task_id: 'elowen-1', status: 'in_progress' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1', expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'in_progress' }), // title/description absent, not sent as undefined
      }));
      expect(res.content[0]!.text).toContain('in_progress');
    });

    it('carries a rename and a new description together', async () => {
      const f = fakeFetch(200, { id: 'elowen-1' });
      await updateTool(f).execute('call-5', { task_id: 'elowen-1', title: 'New title', description: 'Why' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1', expect.objectContaining({
        body: JSON.stringify({ title: 'New title', description: 'Why' }),
      }));
    });

    it('escapes the task id into the path', async () => {
      const f = fakeFetch(200, {});
      await updateTool(f).execute('call-6', { task_id: 'a/b?c', status: 'closed' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/a%2Fb%3Fc', expect.anything());
    });

    it('refuses an empty update instead of firing a no-op PATCH that reads as success', async () => {
      const f = fakeFetch(200, {});
      const res = await updateTool(f).execute('call-7', { task_id: 'elowen-1' });
      expect(f).not.toHaveBeenCalled();
      expect(res.content[0]!.text).toMatch(/nothing to update/i);
    });
  });

  describe('ElowenGetTask', () => {
    it('GETs /tasks/:id', async () => {
      const f = fakeFetch(200, { id: 'elowen-9', title: 'Inspect' });
      await toolNamed(f, 'ElowenGetTask').execute('c', { task_id: 'elowen-9' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-9', expect.objectContaining({ method: 'GET' }));
    });
  });

  describe('ElowenStopTask', () => {
    it('reverts a task to open by default (PATCH status=open)', async () => {
      const f = fakeFetch(200, { id: 'elowen-1', status: 'open' });
      const res = await toolNamed(f, 'ElowenStopTask').execute('c', { task_id: 'elowen-1' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1', expect.objectContaining({
        method: 'PATCH', body: JSON.stringify({ status: 'open' }),
      }));
      expect(res.content[0]!.text).toContain('open');
    });

    it('cancels the task when cancel=true (PATCH status=cancelled)', async () => {
      const f = fakeFetch(200, { id: 'elowen-1', status: 'cancelled' });
      await toolNamed(f, 'ElowenStopTask').execute('c', { task_id: 'elowen-1', cancel: true });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1', expect.objectContaining({
        method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }),
      }));
    });

    it('escapes the task id into the path', async () => {
      const f = fakeFetch(200, {});
      await toolNamed(f, 'ElowenStopTask').execute('c', { task_id: 'a/b?c' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/a%2Fb%3Fc', expect.objectContaining({ method: 'PATCH' }));
    });
  });

  describe('ElowenTaskOutput', () => {
    it('composes result_summary + outcome (from /tasks/:id) with usage (from /usage)', async () => {
      const f = routedFetch([
        { suffix: '/tasks/elowen-1', status: 200, body: { id: 'elowen-1', result_summary: 'did it', outcome: 'success' } },
        { suffix: '/tasks/elowen-1/usage', status: 200, body: { input: 10, output: 5 } },
      ]);
      const res = await toolNamed(f, 'ElowenTaskOutput').execute('c', { task_id: 'elowen-1' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1', expect.objectContaining({ method: 'GET' }));
      expect(f).toHaveBeenCalledWith('http://x/tasks/elowen-1/usage', expect.objectContaining({ method: 'GET' }));
      const text = res.content[0]!.text;
      expect(text).toContain('did it');
      expect(text).toContain('success');
      expect(text).toContain('"input": 10');
    });

    it('renders a readable message when usage is null (not the literal text "null")', async () => {
      const f = routedFetch([
        { suffix: '/tasks/elowen-2', status: 200, body: { id: 'elowen-2', result_summary: 's', outcome: 'o' } },
        { suffix: '/tasks/elowen-2/usage', status: 200, body: null },
      ]);
      const res = await toolNamed(f, 'ElowenTaskOutput').execute('c', { task_id: 'elowen-2' });
      expect(res.content[0]!.text).toContain('no usage recorded');
    });

    it('escapes the task id into both endpoint paths', async () => {
      const f = routedFetch([
        { suffix: '/tasks/a%2Fb%3Fc', status: 200, body: {} },
        { suffix: '/tasks/a%2Fb%3Fc/usage', status: 200, body: null },
      ]);
      await toolNamed(f, 'ElowenTaskOutput').execute('c', { task_id: 'a/b?c' });
      expect(f).toHaveBeenCalledWith('http://x/tasks/a%2Fb%3Fc', expect.anything());
      expect(f).toHaveBeenCalledWith('http://x/tasks/a%2Fb%3Fc/usage', expect.anything());
    });
  });

  it('surfaces API errors as text instead of throwing', async () => {
    const f = fakeFetch(500, { error: 'boom' });
    const tool = buildWorkTools({ url: 'http://x', token: 't', fetchImpl: f }).find((t) => t.name === 'ElowenListTasks')!;
    const res = await tool.execute('call-3', {});
    expect(res.content[0]!.text).toContain('HTTP 500');
  });
});
