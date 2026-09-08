import { describe, expect, it, vi } from 'vitest';
import { registerEnvironmentApi } from '../../plugins/sandbox/lib/environmentApi.mjs';

type Route = { method?: string; handler: (req: any) => Promise<any> };

function setup(options: { lifecycle?: string; canManage?: boolean; accessible?: number[] | null } = {}) {
  const project = { id: 7, lifecycle: options.lifecycle ?? 'active' };
  const stores = {
    projects: { get: vi.fn((id: number) => (id === 7 ? project : null)) },
    userProjects: { canManage: vi.fn(() => options.canManage ?? false) },
  };
  const routes = new Map<string, Route[]>();
  const ctx = {
    host: { stores: () => stores },
    registerApiRoute: vi.fn((route: any) => {
      const list = routes.get(route.path) ?? [];
      list.push({ method: route.method, handler: route.handler });
      routes.set(route.path, list);
    }),
  };
  const control = {
    projectOverview: vi.fn(async () => ({ environment: { projectId: 7, state: 'running' }, snapshots: [], operations: [] })),
    requestEnvironment: vi.fn(async () => ({ id: 'op_1', status: 'pending' })),
    environmentFor: vi.fn(), environmentOperation: vi.fn(), environmentSnapshots: vi.fn(), environmentLogs: vi.fn(),
    projectFiles: vi.fn(), managedWorktrees: vi.fn(),
  };
  registerEnvironmentApi(ctx as any, { control } as any);
  const handler = (method: 'GET' | 'POST') => {
    const route = routes.get('projects')?.find((entry) => entry.method === method);
    if (!route) throw new Error(`missing ${method} projects route`);
    return route.handler;
  };
  const request = async (method: 'GET' | 'POST', path: string, init: { auth?: any; json?: any; rejectJson?: boolean } = {}) =>
    handler(method)({ method, path, query: {}, headers: {},
      auth: init.auth ?? { userId: 1, admin: false, accessibleProjects: init.json === undefined ? options.accessible ?? [7] : options.accessible ?? [7] },
      json: async () => { if (init.rejectJson) throw new SyntaxError('Unexpected token'); return init.json; } });
  return { ctx, control, stores, project, routes, request };
}

describe('UI projects/:id/environment API', () => {
  it('registers the namespaced projects mount beside the legacy environments routes', () => {
    const { routes } = setup();
    expect(routes.get('projects')?.map((route) => route.method).sort()).toEqual(['GET', 'POST']);
    for (const path of ['environments/status', 'environments/request', 'environments/operation', 'environments/snapshots', 'environments/logs', 'environments/files', 'environments/worktrees']) {
      expect(routes.get(path)?.length).toBeGreaterThan(0);
    }
  });

  it('parses only an optional leading slash, a positive id and the /environment suffix', async () => {
    const { control, request } = setup();
    for (const path of ['/7/environment', '7/environment']) {
      const response = await request('GET', path);
      expect(response.status).toBe(200);
      expect(control.projectOverview).toHaveBeenCalledWith({ project: { kind: 'managed', projectId: 7 }, accountUserId: 1 });
    }
    for (const path of ['', 'environment', '7', '7/', '7/other', '7/environment/x', '0/environment', '-3/environment', 'abc/environment', '07/environment', '7%2Fenvironment']) {
      const response = await request('GET', path);
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    }
    const post = await request('POST', '7x/environment');
    expect(post.status).toBe(404);
    expect(control.projectOverview).toHaveBeenCalledTimes(2);
  });

  it('serves the read-only overview over GET and never provisions', async () => {
    const { control, request } = setup();
    const response = await request('GET', '7/environment');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ environment: { projectId: 7, state: 'running' }, snapshots: [], operations: [] });
    expect(control.projectOverview).toHaveBeenCalledOnce();
    expect(control.requestEnvironment).not.toHaveBeenCalled();
    expect(control.environmentFor).not.toHaveBeenCalled();
  });

  it('authenticates the actor before anything else', async () => {
    const { control, request } = setup();
    for (const auth of [{ userId: null, admin: false, accessibleProjects: [7] }, { userId: 0, admin: false, accessibleProjects: [7] }]) {
      expect((await request('GET', '7/environment', { auth })).status).toBe(401);
      expect((await request('POST', '7/environment', { auth, json: { action: { kind: 'start' } } })).status).toBe(401);
    }
    expect(control.projectOverview).not.toHaveBeenCalled();
  });

  it('scopes by accessibleProjects, allowing only deleting-project managers outside it', async () => {
    const base = setup({ accessible: [8] });
    expect((await base.request('GET', '7/environment')).status).toBe(403);
    expect((await base.request('POST', '7/environment', { json: { action: { kind: 'start' } } })).status).toBe(403);
    expect(base.control.projectOverview).not.toHaveBeenCalled();

    const deleting = setup({ accessible: [8], lifecycle: 'deleting', canManage: true });
    expect((await deleting.request('GET', '7/environment')).status).toBe(200);
    expect(deleting.stores.projects.get).toHaveBeenCalledWith(7);
    expect(deleting.stores.userProjects.canManage).toHaveBeenCalledWith(1, 7);
    const retried = await deleting.request('POST', '7/environment', { json: { action: { kind: 'delete' }, requestId: 'del-1' } });
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ id: 'op_1', status: 'pending' });

    const notManager = setup({ accessible: [8], lifecycle: 'deleting', canManage: false });
    expect((await notManager.request('GET', '7/environment')).status).toBe(403);
    expect((await notManager.request('POST', '7/environment', { json: { action: { kind: 'delete' } } })).status).toBe(403);

    const active = setup({ accessible: [8], lifecycle: 'active', canManage: true });
    expect((await active.request('GET', '7/environment')).status).toBe(403);
    expect((await active.request('POST', '7/environment', { json: { action: { kind: 'delete' } } })).status).toBe(403);
  });

  it('treats a null scope as unscoped like the legacy routes', async () => {
    const { request } = setup({ accessible: null });
    expect((await request('GET', '7/environment')).status).toBe(200);
    expect((await request('POST', '7/environment', { json: { action: { kind: 'start' } } })).status).toBe(200);
  });

  it('returns the EnvironmentOperation directly from a strict POST body', async () => {
    const { control, request } = setup();
    const response = await request('POST', '7/environment', { json: { action: { kind: 'start' }, requestId: 'start-1', expectedGeneration: 2 } });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 'op_1', status: 'pending' });
    expect(control.requestEnvironment).toHaveBeenCalledTimes(1);
    expect(control.requestEnvironment).toHaveBeenCalledWith({
      project: { kind: 'managed', projectId: 7 }, accountUserId: 1, action: { kind: 'start' }, requestId: 'start-1', expectedGeneration: 2,
    });
    for (const json of [
      [], 'start', 5,
      { action: { kind: 'start' }, accountUserId: 9 },
      { action: { kind: 'start' }, sneaky: true },
      { action: { kind: 'start' }, requestId: 'bad id!' },
      { action: { kind: 'start' }, expectedGeneration: 2.5 },
      { requestId: 'start-1' },
      { action: 'start' },
    ]) {
      const rejected = await request('POST', '7/environment', { json: json as any });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe('invalid_body');
    }
    const malformed = await request('POST', '7/environment', { rejectJson: true });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_body');
    expect(control.requestEnvironment).toHaveBeenCalledTimes(1);
  });

  it('keeps the actor from the verified token only and maps control errors to JSON errors', async () => {
    const control = {
      projectOverview: async () => { throw Object.assign(new Error('denied'), { code: 'project_forbidden', status: 403 }); },
      requestEnvironment: async () => { throw Object.assign(new Error('busy'), { code: 'environment_busy', status: 503 }); },
    };
    const routes = new Map<string, Route[]>();
    const ctx = { host: { stores: () => ({ projects: { get: () => null }, userProjects: { canManage: () => false } }) },
      registerApiRoute: (route: any) => { routes.set(route.path, [...(routes.get(route.path) ?? []), route]); } };
    registerEnvironmentApi(ctx as any, { control } as any);
    const invoke = (method: 'GET' | 'POST', json?: any) => routes.get('projects')!.find((route) => route.method === method)!
      .handler({ method, path: '7/environment', query: {}, headers: {}, auth: { userId: 1, admin: false, accessibleProjects: [7] }, json: async () => json });
    const get = await invoke('GET');
    expect(get.status).toBe(403);
    expect(get.body).toMatchObject({ error: 'project_forbidden' });
    const post = await invoke('POST', { action: { kind: 'start' } });
    expect(post.status).toBe(503);
    expect(post.body).toMatchObject({ error: 'environment_busy' });
    const broke = { projectOverview: () => { throw new Error('boom'); }, requestEnvironment: () => {} };
    const otherRoutes = new Map<string, Route[]>();
    registerEnvironmentApi({ host: ctx.host, registerApiRoute: (route: any) => { otherRoutes.set(route.path, [...(otherRoutes.get(route.path) ?? []), route]); } } as any, { control: broke } as any);
    const unhandled = await otherRoutes.get('projects')!.find((route) => route.method === 'GET')!
      .handler({ method: 'GET', path: '7/environment', query: {}, headers: {}, auth: { userId: 1, admin: false, accessibleProjects: [7] }, json: async () => undefined });
    expect(unhandled.status).toBe(500);
    expect(unhandled.body).toMatchObject({ error: 'environment_error' });
  });
});