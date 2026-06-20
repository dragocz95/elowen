import { describe, it, expect, vi, afterEach } from 'vitest';
import { OrcaClient } from '../../src/cli/client.js';

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
afterEach(() => vi.restoreAllMocks());

describe('OrcaClient', () => {
  it('createTask POSTs to /tasks', async () => {
    const calls: any[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'orca-1' }), { status: 201 }); }) as any;
    const c = new OrcaClient('http://localhost:4400');
    const t = await c.createTask({ id: 'orca-1', project_id: 1, title: 'X' });
    expect(t.id).toBe('orca-1');
    expect(calls[0].url).toBe('http://localhost:4400/tasks');
    expect(calls[0].init.method).toBe('POST');
  });

  it('throws a clear error on a 200 non-JSON response rather than a raw SyntaxError', async () => {
    global.fetch = vi.fn(async () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as any;
    const c = new OrcaClient('http://localhost:4400');
    await expect(c.tasks()).rejects.toThrow(/non-JSON/);
  });

  it('close PATCHes the task to closed and sends the bearer token', async () => {
    const calls: any[] = [];
    global.fetch = vi.fn(async (url: any, init: any) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'orca-1', status: 'closed' }), { status: 200 }); }) as any;
    const c = new OrcaClient('http://localhost:4400', 'svc-token');
    await c.close('orca-1');
    expect(calls[0].url).toBe('http://localhost:4400/tasks/orca-1');
    expect(calls[0].init.method).toBe('PATCH');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer svc-token');
  });
});

describe('OrcaClient reasoning verbs', () => {
  it('planSubmit POSTs phases to the job submit endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({ status: 'done' }));
    const c = new OrcaClient('http://x', 'tok');
    await c.planSubmit('pj-1', [{ title: 'A', type: 'task' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://x/plan/pj-1/submit');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ phases: [{ title: 'A', type: 'task' }] });
  });
  it('overseerPoll GETs the next endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({}));
    await new OrcaClient('http://x', 'tok').overseerPoll('m1');
    expect(fetchMock.mock.calls[0]![0]).toBe('http://x/missions/m1/overseer/next');
  });
  it('overseerDecide POSTs the verdict', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(ok({}));
    await new OrcaClient('http://x', 'tok').overseerDecide('m1', { id: 'd1', approve: true, confidence: 0.8, rationale: 'ok' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://x/missions/m1/overseer/decide');
    expect(JSON.parse(init!.body as string)).toEqual({ id: 'd1', approve: true, confidence: 0.8, rationale: 'ok' });
  });
});
