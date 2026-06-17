import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';

const server = setupServer(
  http.get('http://localhost:4400/tasks', () => HttpResponse.json([{ id: 'orca-1', title: 'A', status: 'open' }])),
  http.get('http://localhost:4400/missions', () => new HttpResponse(null, { status: 500 })),
);
beforeAll(() => server.listen()); afterEach(() => server.resetHandlers()); afterAll(() => server.close());

describe('orcaClient', () => {
  it('tasks() returns parsed JSON', async () => {
    const tasks = await orcaClient.tasks();
    expect(tasks[0].id).toBe('orca-1');
  });
  it('throws OrcaApiError with status on non-ok', async () => {
    await expect(orcaClient.missions()).rejects.toMatchObject({ status: 500 });
    await expect(orcaClient.missions()).rejects.toBeInstanceOf(OrcaApiError);
  });
});
