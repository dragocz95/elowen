import { describe, it, expect, vi } from 'vitest';
import { OrcaClient } from '../../src/cli/client.js';

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
});
