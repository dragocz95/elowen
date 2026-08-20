// @vitest-environment node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMicrosoftTools } from '../plugins/msteams/lib/microsoftTools.mjs';

const originalFetch = globalThis.fetch;
const tempRoot = '/tmp/msteams-m365-tools-test';
afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await rm(tempRoot, { recursive: true, force: true });
});

type Tool = { execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }> };

function harness(config: Record<string, unknown> = { m365AccessMode: 'read_write' }, subjectId = 'aad-1') {
  const tools = new Map<string, Tool>();
  const linking = {
    delegatedSession: vi.fn(async () => ({
      token: 'delegated-secret-token',
      subjectId,
      tenantId: 'tenant-1',
      profile: { id: subjectId, displayName: 'Alex' },
    })),
  };
  const ctx = {
    currentIdentity: () => ({ platform: 'msteams', userId: subjectId, elowenUserId: 7 }),
    currentWorkDir: () => tempRoot,
    host: { projectFiles: () => ({ safe: (_root: string, path: string) => `${tempRoot}/${path}` }) },
    registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
  };
  registerMicrosoftTools(ctx, linking, config);
  const run = async (name: string, params: Record<string, unknown>) => {
    const result = await tools.get(name)!.execute('call-1', params);
    return result.content.map((item) => item.text).join('\n');
  };
  return { tools, linking, run };
}

describe('delegated Microsoft 365 tools', () => {
  it('registers eight understandable domain tools', () => {
    const { tools } = harness();
    expect([...tools.keys()]).toEqual([
      'MicrosoftDirectory', 'MicrosoftSharePoint', 'MicrosoftFiles', 'MicrosoftOutlook',
      'MicrosoftTasks', 'MicrosoftOneNote', 'MicrosoftExcel', 'MicrosoftTeams',
    ]);
  });

  it('uses the turn-bound delegated session and never returns its token', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'aad-1', displayName: 'Alex' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const { linking, run } = harness();
    const text = await run('MicrosoftDirectory', { action: 'me' });
    expect(linking.delegatedSession).toHaveBeenCalledWith(expect.objectContaining({ platform: 'msteams', userId: 'aad-1' }));
    expect(text).toContain('Alex');
    expect(text).not.toContain('delegated-secret-token');
  });

  it('shows permission context only for classified authorization failures', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'itemNotFound', message: 'Item not found' } }), {
        status: 404, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Access denied' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      }));
    const { run } = harness();

    const missing = await run('MicrosoftFiles', { action: 'search', query: 'missing' });
    expect(missing).toContain('Item not found');
    expect(missing).not.toContain('delegated permission');

    const denied = await run('MicrosoftSharePoint', { action: 'search_sites', query: 'chetty' });
    expect(denied).toContain('Delegated permission for this operation: Sites.ReadWrite.All');
  });

  it('escapes apostrophes inside Graph OData string literals', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    await run('MicrosoftFiles', { action: 'search', query: "O'Brien" });
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain("search(q='O''Brien')");

    await run('MicrosoftExcel', { action: 'read_range', itemId: 'book-1', worksheet: 'Sheet1', range: "A'1" });
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1]?.[0])).toContain("range(address='A''1')");
  });

  it('blocks writes globally in read-only mode before Graph is called', async () => {
    globalThis.fetch = vi.fn();
    const { run } = harness({ m365AccessMode: 'read_only' });
    const text = await run('MicrosoftOutlook', {
      resource: 'mail', action: 'send', to: ['person@example.com'], subject: 'Hello', body: 'World', commit: true,
    });
    expect(text).toContain('writes are disabled');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('previews an authorized mutation without calling Graph', async () => {
    globalThis.fetch = vi.fn();
    const { run } = harness();
    const text = await run('MicrosoftOutlook', {
      resource: 'mail', action: 'send', to: ['person@example.com'], subject: 'Hello', body: 'World',
    });
    expect(text).toContain('"committed": false');
    expect(text).toContain('person@example.com');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('commits the exact mail send once and does not echo the bearer', async () => {
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('POST');
      expect(String(init?.body)).toContain('person@example.com');
      return new Response(null, { status: 202 });
    });
    const { run } = harness();
    const text = await run('MicrosoftOutlook', {
      resource: 'mail', action: 'send', to: ['person@example.com'], subject: 'Hello', body: 'World', commit: true,
    });
    expect(text).toContain('"sent": true');
    expect(text).not.toContain('delegated-secret-token');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not blindly retry a failed resumable upload chunk', async () => {
    await mkdir(tempRoot, { recursive: true });
    await writeFile(`${tempRoot}/large.bin`, new Uint8Array(4 * 1024 * 1024 + 1));
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ uploadUrl: 'https://chunk.up.1drv.com/upload/session' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }));
    const { run } = harness();
    const result = await run('MicrosoftFiles', { action: 'upload', path: 'large.bin', name: 'large.bin', commit: true });
    expect(result).toContain('refused bytes');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('binds opaque Excel sessions to one Microsoft subject and workbook', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'raw-session-secret' }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address: 'Sheet1!A1', values: [['ok']] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const first = harness();
    const created = JSON.parse(await first.run('MicrosoftExcel', { action: 'create_session', itemId: 'book-1', commit: true }));
    expect(created.session).toBeTypeOf('string');
    expect(created.session).not.toContain('raw-session-secret');
    const read = await first.run('MicrosoftExcel', { action: 'read_range', itemId: 'book-1', worksheet: 'Sheet1', range: 'A1', session: created.session });
    expect(read).toContain('ok');
    expect(vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.headers).toMatchObject({ 'workbook-session-id': 'raw-session-secret' });

    globalThis.fetch = vi.fn();
    const other = harness({ m365AccessMode: 'read_write' }, 'aad-2');
    const denied = await other.run('MicrosoftExcel', { action: 'read_range', itemId: 'book-1', worksheet: 'Sheet1', range: 'A1', session: created.session });
    expect(denied).toContain('another Microsoft identity');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('lists joined Teams without the unsupported $top query option', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ value: [
      { id: 'team-1', displayName: 'One' }, { id: 'team-2', displayName: 'Two' },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    const result = JSON.parse(await run('MicrosoftTeams', { action: 'list_joined_teams', limit: 1 }));
    expect(result).toMatchObject({ items: [{ id: 'team-1' }], summary: '1 joined teams' });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toBe('https://graph.microsoft.com/v1.0/me/joinedTeams?$select=id,displayName,description,webUrl,isArchived');
    expect(init?.method).toBe('GET');
  });

  it('hard-disables destructive Microsoft 365 actions before Graph is called', async () => {
    globalThis.fetch = vi.fn();
    const { tools, run } = harness();
    expect(tools.get('MicrosoftSharePoint')?.description).not.toContain('delete_item');
    expect(tools.get('MicrosoftFiles')?.description).not.toMatch(/Actions:.*\bdelete\b/);
    expect(tools.get('MicrosoftOutlook')?.description).not.toMatch(/\b(delete|cancel_event)\b/);
    expect(tools.get('MicrosoftTasks')?.description).not.toMatch(/\b(delete|delete_task)\b/);

    const results = await Promise.all([
      run('MicrosoftSharePoint', { action: 'delete_item', siteId: 'site-1', listId: 'list-1', itemId: 'item-1', commit: true }),
      run('MicrosoftFiles', { action: 'delete', itemId: 'file-1', commit: true }),
      run('MicrosoftOutlook', { resource: 'mail', action: 'delete', messageId: 'message-1', commit: true }),
      run('MicrosoftOutlook', { resource: 'calendar', action: 'cancel_event', id: 'event-1', commit: true }),
      run('MicrosoftOutlook', { resource: 'contacts', action: 'delete', id: 'contact-1', commit: true }),
      run('MicrosoftTasks', { service: 'todo', action: 'delete', taskListId: 'list-1', id: 'task-1', commit: true }),
      run('MicrosoftTasks', { service: 'planner', action: 'delete_task', id: 'task-1', etag: 'etag', commit: true }),
    ]);

    for (const result of results) expect(result).toMatch(/(deletion|cancellation) is disabled by policy/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('searches SharePoint content with normalized hits and an opaque cursor', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      value: [{ hitsContainers: [{ total: 3, moreResultsAvailable: true, hits: [{
        rank: 1, summary: '<c0>Retence</c0> tabulka<ddd/>',
        resource: {
          '@odata.type': '#microsoft.graph.driveItem', id: 'file-1', name: 'Retence.xlsx',
          webUrl: 'https://contoso.sharepoint.com/sites/team/Retence.xlsx', lastModifiedDateTime: '2026-08-20T00:00:00Z',
          parentReference: { siteId: 'site-1', driveId: 'drive-1', sharepointIds: { listId: 'list-1', listItemId: '7' } },
          file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        },
      }] }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    const first = JSON.parse(await run('MicrosoftSharePoint', { action: 'search_content', query: 'Retence', limit: 2 }));
    expect(first).toMatchObject({
      summary: '1 of 3 matches', untrusted: true,
      items: [{ untrusted: true, kind: 'driveItem', id: 'file-1', name: 'Retence.xlsx', summary: 'Retence tabulka', siteId: 'site-1', driveId: 'drive-1' }],
    });
    expect(first.nextCursor).toBeTypeOf('string');
    await run('MicrosoftSharePoint', { action: 'search_content', query: 'Retence', limit: 2, cursor: first.nextCursor });
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      ['https://graph.microsoft.com/v1.0/search/query', 'POST'],
      ['https://graph.microsoft.com/v1.0/search/query', 'POST'],
    ]);
    expect(calls.map((call) => JSON.parse(String(call[1]?.body)).requests[0].from)).toEqual([0, 2]);
    const edgeCursor = Buffer.from(JSON.stringify({ kind: 'sharepoint-search', query: 'Retence', from: 990 })).toString('base64url');
    const edge = JSON.parse(await run('MicrosoftSharePoint', { action: 'search_content', query: 'Retence', limit: 50, cursor: edgeCursor }));
    expect(edge).not.toHaveProperty('nextCursor');
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.body)).requests[0]).toMatchObject({ from: 990, size: 10 });
    expect(await run('MicrosoftSharePoint', { action: 'search_content', query: 'Other', cursor: first.nextCursor })).toContain('cursor belongs to a different');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('previews page and calendar mutations without create-only identifiers', async () => {
    globalThis.fetch = vi.fn();
    const { run } = harness();
    const cases = [
      ['MicrosoftSharePoint', { action: 'create_page', siteId: 'site-1', fields: { name: 'smoke.aspx', title: 'Smoke' } }],
      ['MicrosoftOutlook', { resource: 'calendar', action: 'update_event', id: 'event-1', fields: { subject: 'Updated' } }],
      ['MicrosoftOutlook', { resource: 'calendar', action: 'respond_event', id: 'event-1', response: 'accept' }],
    ] as const;
    for (const [tool, params] of cases) expect(await run(tool, params)).toContain('"committed": false');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('validates and normalizes SharePoint page creation', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'page-1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    await run('MicrosoftSharePoint', {
      action: 'create_page', siteId: 'site-1', commit: true,
      fields: { name: 'smoke.aspx', title: 'Smoke', pageLayout: '   ', '@odata.type': '#unsafe' },
    });
    expect(JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body))).toEqual({
      name: 'smoke.aspx', title: 'Smoke', pageLayout: 'article', '@odata.type': '#microsoft.graph.sitePage',
    });
    globalThis.fetch = vi.fn();
    expect(await run('MicrosoftSharePoint', { action: 'create_page', siteId: 'site-1', fields: { title: 'Missing name' } })).toContain('fields.name is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('builds valid Planner create payloads', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'created' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    await run('MicrosoftTasks', { service: 'planner', action: 'create_task', planId: 'plan-1', subject: 'Task', commit: true });
    await run('MicrosoftTasks', { service: 'planner', action: 'create_bucket', planId: 'plan-1', subject: 'Bucket', commit: true });
    await run('MicrosoftTasks', { service: 'planner', action: 'create_plan', groupId: 'group-1', subject: 'Plan', commit: true });
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expect(calls.map((call) => [String(call[0]), call[1]?.method])).toEqual([
      ['https://graph.microsoft.com/v1.0/planner/tasks', 'POST'],
      ['https://graph.microsoft.com/v1.0/planner/buckets', 'POST'],
      ['https://graph.microsoft.com/v1.0/planner/plans', 'POST'],
    ]);
    expect(calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { title: 'Task', planId: 'plan-1' },
      { name: 'Bucket', planId: 'plan-1', orderHint: ' !' },
      { title: 'Plan', container: { url: 'https://graph.microsoft.com/v1.0/groups/group-1' } },
    ]);
    globalThis.fetch = vi.fn();
    expect(await run('MicrosoftTasks', { service: 'planner', action: 'create_plan', subject: 'Plan' })).toContain('groupId is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('reports User.Read as the permission for the signed-in profile', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied', message: 'Denied' } }), { status: 403, headers: { 'content-type': 'application/json' } }));
    const { run } = harness();
    const text = await run('MicrosoftDirectory', { action: 'me' });
    expect(text).toContain('Delegated permission for this operation: User.Read');
    expect(text).not.toContain('User.Read.All');
  });

  it('requires Planner etags for updates', async () => {
    globalThis.fetch = vi.fn();
    const { run } = harness();
    const text = await run('MicrosoftTasks', { service: 'planner', action: 'update_task', id: 'task-1', fields: { title: 'Updated' }, commit: true });
    expect(text).toContain('etag is required');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
