import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { DelegatedGraphClient, DelegatedGraphError, bounded, htmlToText } from './delegatedGraph.mjs';

const P = {
  me: 'User.Read',
  directory: 'User.Read.All / GroupMember.Read.All',
  people: 'People.Read',
  sites: 'Sites.ReadWrite.All',
  files: 'Files.ReadWrite.All',
  mail: 'Mail.ReadWrite / Mail.Send',
  calendar: 'Calendars.ReadWrite',
  contacts: 'Contacts.ReadWrite',
  tasks: 'Tasks.ReadWrite',
  planner: 'Tasks.ReadWrite / Group.ReadWrite.All',
  notes: 'Notes.ReadWrite.All',
  teams: 'Chat.ReadWrite / ChannelMessage.Read.All / ChannelMessage.Send',
};

const enc = (v) => encodeURIComponent(String(v ?? '').trim());
const nonempty = (value, label) => {
  const out = String(value ?? '').trim();
  if (!out) throw new TypeError(`${label} is required.`);
  return out;
};
const json = (value, max) => bounded(value, max);
const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : json(value) }], details: {} });
const PERMISSION_ERROR_CODES = new Set([
  'accessdenied', 'authorization_requestdenied', 'authorizationdenied',
  'erroraccessdenied', 'forbidden', 'insufficientprivileges',
]);
const permissionHint = (error) => error.permission && error.status === 403
  && PERMISSION_ERROR_CODES.has(String(error.code ?? '').toLowerCase())
  ? ` Delegated permission for this operation: ${error.permission}.`
  : '';
const fail = (error) => {
  if (error instanceof DelegatedGraphError) {
    const permission = permissionHint(error);
    const retry = error.retryAfter ? ` Retry after ${error.retryAfter}s.` : '';
    const request = error.requestId ? ` Request ID: ${error.requestId}.` : '';
    return ok(`Error: ${error.message}${permission}${retry}${request}`);
  }
  return ok(`Error: ${error instanceof Error ? error.message : String(error)}`);
};
const trimObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const limitOf = (p) => Math.min(Math.max(Number(p.limit) || 20, 1), 50);
const SEARCH_MAX_RESULTS = 1_000;
const searchCursor = (query, from) => Buffer.from(JSON.stringify({ kind: 'sharepoint-search', query, from })).toString('base64url');
const searchOffset = (cursor, query) => {
  if (!cursor) return 0;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')); } catch { parsed = null; }
  if (parsed?.kind !== 'sharepoint-search' || parsed.query !== query || !Number.isSafeInteger(parsed.from) || parsed.from < 0 || parsed.from >= SEARCH_MAX_RESULTS) {
    throw new TypeError('Search cursor belongs to a different Microsoft SharePoint query.');
  }
  return parsed.from;
};
const quoted = (value) => String(value).replace(/'/g, "''");
const workbookSessions = new Map();
const WORKBOOK_SESSION_TTL_MS = 10 * 60_000;

function workbookSession(handle, subjectId, itemId) {
  if (!handle) return undefined;
  const row = workbookSessions.get(String(handle));
  if (!row || row.expiresAt <= Date.now()) {
    workbookSessions.delete(String(handle));
    throw new Error('Excel workbook session expired. Create a new session.');
  }
  if (row.subjectId !== subjectId || row.itemId !== itemId) throw new Error('Excel workbook session belongs to another Microsoft identity or workbook.');
  row.expiresAt = Date.now() + WORKBOOK_SESSION_TTL_MS;
  return row.id;
}

const commonFields = {
  action: Type.String({ description: 'Domain action named in the tool description.' }),
  resource: Type.Optional(Type.String()),
  service: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  groupId: Type.Optional(Type.String()),
  siteId: Type.Optional(Type.String()),
  listId: Type.Optional(Type.String()),
  itemId: Type.Optional(Type.String()),
  pageId: Type.Optional(Type.String()),
  driveId: Type.Optional(Type.String()),
  chatId: Type.Optional(Type.String()),
  teamId: Type.Optional(Type.String()),
  channelId: Type.Optional(Type.String()),
  messageId: Type.Optional(Type.String()),
  calendarId: Type.Optional(Type.String()),
  taskListId: Type.Optional(Type.String()),
  planId: Type.Optional(Type.String()),
  bucketId: Type.Optional(Type.String()),
  notebookId: Type.Optional(Type.String()),
  sectionId: Type.Optional(Type.String()),
  worksheet: Type.Optional(Type.String()),
  table: Type.Optional(Type.String()),
  range: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  targetPath: Type.Optional(Type.String()),
  parentId: Type.Optional(Type.String()),
  destinationId: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  bodyType: Type.Optional(Type.String()),
  to: Type.Optional(Type.Array(Type.String())),
  cc: Type.Optional(Type.Array(Type.String())),
  start: Type.Optional(Type.String()),
  end: Type.Optional(Type.String()),
  timeZone: Type.Optional(Type.String()),
  attendees: Type.Optional(Type.Array(Type.String())),
  response: Type.Optional(Type.String()),
  comment: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  values: Type.Optional(Type.Array(Type.Array(Type.Unknown()))),
  formulas: Type.Optional(Type.Array(Type.Array(Type.Unknown()))),
  assignments: Type.Optional(Type.Array(Type.String())),
  linkType: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  etag: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  session: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  depth: Type.Optional(Type.Number({ minimum: 1, maximum: 5 })),
  commit: Type.Optional(Type.Boolean({ description: 'Mutations preview by default. Set true only when the exact external change is authorized.' })),
};
const parameters = (description) => Type.Object(commonFields, { description });

function mutationGate(cfg, p, preview) {
  if (String(cfg.m365AccessMode ?? 'read_only') !== 'read_write') {
    return { result: ok('Error: Microsoft 365 writes are disabled. Set “Microsoft 365 access” to read/write in the Teams plugin settings.') };
  }
  if (p.commit !== true) return { result: ok({ preview, committed: false }) };
  return { result: null };
}

function clientFor(ctx, linking, cfg) {
  return async () => {
    if (!linking) throw new Error('Microsoft account linking is not configured.');
    const session = await linking.delegatedSession(ctx.currentIdentity?.());
    return { graph: new DelegatedGraphClient(session.token, { outputLimit: 20_000 }), session, cfg };
  };
}

function register(ctx, name, label, description, execute) {
  ctx.registerTool(defineTool({
    name, label, description,
    parameters: parameters(description),
    execute: async (_id, p) => {
      try { return await execute(p); } catch (error) { return fail(error); }
    },
  }));
}

export function registerMicrosoftTools(ctx, linking, cfg) {
  const get = clientFor(ctx, linking, cfg);

  register(ctx, 'MicrosoftDirectory', 'Microsoft directory',
    'Read the signed-in user, relevant people, Entra users, organisation chart, group memberships and group members. Actions: me, search_people, get_user, org_chart, memberships, get_group, group_members.',
    async (p) => directory(await get(), p));

  register(ctx, 'MicrosoftSharePoint', 'Microsoft SharePoint',
    'Search and manage SharePoint content, sites, lists, list items and modern pages. Actions: search_content, search_sites, get_site, list_lists, list_items, get_item, create_item, update_item, list_pages, get_page, create_page, update_page, publish_page. Deletion is disabled by policy.',
    async (p) => sharepoint(await get(), p));

  register(ctx, 'MicrosoftFiles', 'Microsoft files',
    'Search and manage OneDrive or SharePoint drive items. Actions: search, list, get, read_text, download, upload, create_folder, copy, move, rename, create_link, list_versions, restore_version. Deletion is disabled by policy.',
    async (p) => files(await get(), ctx, p));

  register(ctx, 'MicrosoftOutlook', 'Microsoft Outlook',
    'Use Outlook mail, calendar or contacts. Set resource=mail|calendar|contacts. Mail actions: search, list, get, create_draft, send_draft, send, reply, forward, move, archive. Calendar: list_calendars, list_events, get_event, availability, create_event, update_event, respond_event. Contacts: search, list, get, create, update. Destructive actions are disabled by policy.',
    async (p) => outlook(await get(), p));

  register(ctx, 'MicrosoftTasks', 'Microsoft tasks',
    'Use Microsoft To Do or Planner. Set service=todo|planner. Actions cover lists/plans/buckets/tasks plus get, create, update and complete. Destructive actions are disabled by policy.',
    async (p) => tasks(await get(), p));

  register(ctx, 'MicrosoftOneNote', 'Microsoft OneNote',
    'Read and manage OneNote notebooks, sections and pages. Actions: list_notebooks, get_notebook, list_sections, list_pages, get_page, search_pages, create_notebook, create_section, create_page, update_page.',
    async (p) => oneNote(await get(), p));

  register(ctx, 'MicrosoftExcel', 'Microsoft Excel',
    'Read and update an Excel workbook stored in Microsoft 365. Actions: list_worksheets, list_tables, list_names, read_range, update_range, add_rows, create_table, calculate, create_session, close_session.',
    async (p) => excel(await get(), p));

  register(ctx, 'MicrosoftTeams', 'Microsoft Teams as user',
    'Read and post Teams chats/channels as the signed-in human, not as the bot. Actions: list_chats, get_chat, list_chat_messages, send_chat_message, reply_chat_message, list_joined_teams, list_channels, list_channel_messages, send_channel_message, reply_channel_message, react.',
    async (p) => teams(await get(), p));
}

async function directory({ graph }, p) {
  const action = nonempty(p.action, 'action');
  const select = '$select=id,displayName,userPrincipalName,mail,jobTitle,department,officeLocation,accountEnabled,userType';
  if (action === 'me') return ok(await graph.json('GET', `/me?${select}`, { permission: P.me }));
  if (action === 'search_people') {
    const query = nonempty(p.query, 'query');
    if (String(p.scope ?? p.resource) === 'relevant') {
      return ok(await graph.page(`/me/people?$search=${enc(query)}&$select=id,displayName,userPrincipalName,scoredEmailAddresses,personType`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: '/me/people', permission: P.people }));
    }
    const filter = `startswith(displayName,'${quoted(query)}') or startswith(userPrincipalName,'${quoted(query)}') or startswith(mail,'${quoted(query)}')`;
    return ok(await graph.page(`/users?$filter=${enc(filter)}&${select}`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: '/users', permission: P.directory }));
  }
  if (action === 'get_user') return ok(await graph.json('GET', `/users/${enc(nonempty(p.userId ?? p.id, 'userId'))}?${select}`, { permission: P.directory }));
  if (action === 'org_chart') {
    const id = enc(p.userId || 'me');
    const depth = Math.min(Math.max(Number(p.depth) || 1, 1), 5);
    const chain = [];
    let current = id;
    for (let i = 0; i < depth; i++) {
      try {
        const manager = await graph.json('GET', `/${current === 'me' ? 'me' : `users/${current}`}/manager?$select=id,displayName,userPrincipalName,mail,jobTitle,department`, { permission: P.directory });
        chain.push(manager);
        current = enc(manager.id);
      } catch (error) {
        if (error.status === 404) break;
        throw error;
      }
    }
    const base = p.userId ? `/users/${enc(p.userId)}` : '/me';
    const reports = await graph.page(`${base}/directReports?$select=id,displayName,userPrincipalName,mail,jobTitle,department`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}/directReports`, permission: P.directory });
    return ok({ managers: chain, directReports: reports.items, nextCursor: reports.nextCursor });
  }
  if (action === 'memberships') {
    const base = p.userId ? `/users/${enc(p.userId)}` : '/me';
    return ok(await graph.page(`${base}/memberOf?$select=id,displayName,description,mail,groupTypes,securityEnabled`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}/memberOf`, permission: P.directory }));
  }
  if (action === 'get_group') return ok(await graph.json('GET', `/groups/${enc(nonempty(p.groupId ?? p.id, 'groupId'))}?$select=id,displayName,description,mail,groupTypes,securityEnabled,visibility`, { permission: P.directory }));
  if (action === 'group_members') {
    const id = enc(nonempty(p.groupId ?? p.id, 'groupId'));
    return ok(await graph.page(`/groups/${id}/members?$select=id,displayName,userPrincipalName,mail`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/groups/${id}/members`, permission: P.directory }));
  }
  throw new TypeError(`Unknown MicrosoftDirectory action: ${action}`);
}

async function sharepoint({ graph, cfg }, p) {
  const action = nonempty(p.action, 'action');
  if (action === 'search_content') {
    const query = nonempty(p.query, 'query');
    const limit = limitOf(p);
    const from = searchOffset(p.cursor, query);
    const size = Math.min(limit, SEARCH_MAX_RESULTS - from);
    const data = await graph.json('POST', '/search/query', {
      body: { requests: [{ entityTypes: ['driveItem', 'listItem', 'list'], query: { queryString: query }, from, size }] },
      permission: P.sites,
    });
    const containers = (data?.value ?? []).flatMap((response) => response?.hitsContainers ?? []);
    const seen = new Set();
    const items = containers.flatMap((container) => container?.hits ?? []).flatMap((hit) => {
      const resource = hit?.resource;
      if (!resource || typeof resource !== 'object') return [];
      const key = String(resource.webUrl || `${resource['@odata.type']}:${resource.id || hit.hitId}`);
      if (seen.has(key)) return [];
      seen.add(key);
      const refs = resource.parentReference ?? {};
      const ids = refs.sharepointIds ?? resource.sharepointIds ?? {};
      return [{
        untrusted: true,
        rank: hit.rank,
        kind: String(resource['@odata.type'] ?? '').replace('#microsoft.graph.', ''),
        id: resource.id ?? hit.hitId,
        name: resource.name ?? resource.displayName ?? resource.title,
        summary: htmlToText(hit.summary).slice(0, 1_000),
        webUrl: resource.webUrl,
        lastModifiedDateTime: resource.lastModifiedDateTime,
        siteId: refs.siteId ?? resource.siteId,
        driveId: refs.driveId,
        listId: ids.listId,
        listItemId: ids.listItemId,
        mimeType: resource.file?.mimeType,
      }];
    });
    const more = containers.some((container) => container?.moreResultsAvailable === true);
    const nextFrom = from + size;
    const total = Math.max(items.length, ...containers.map((container) => Number(container?.total) || 0));
    return ok({ items, ...(more && nextFrom < SEARCH_MAX_RESULTS ? { nextCursor: searchCursor(query, nextFrom) } : {}), summary: `${items.length} of ${total} matches`, untrusted: true });
  }
  if (action === 'search_sites') return ok(await graph.page(`/sites?search=${enc(nonempty(p.query, 'query'))}`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: '/sites', permission: P.sites }));
  const site = enc(nonempty(p.siteId, 'siteId'));
  if (action === 'get_site') return ok(await graph.json('GET', `/sites/${site}`, { permission: P.sites }));
  if (action === 'list_lists') return ok(await graph.page(`/sites/${site}/lists?$select=id,displayName,description,webUrl,list`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/sites/${site}/lists`, permission: P.sites }));
  const list = p.listId ? enc(p.listId) : '';
  if (action === 'list_items') return ok(await graph.page(`/sites/${site}/lists/${nonempty(list, 'listId')}/items?$expand=fields`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/sites/${site}/lists/${list}/items`, permission: P.sites }));
  if (action === 'get_item') return ok(await graph.json('GET', `/sites/${site}/lists/${nonempty(list, 'listId')}/items/${enc(nonempty(p.itemId ?? p.id, 'itemId'))}?$expand=fields`, { permission: P.sites }));
  if (action === 'delete_item') throw new Error('SharePoint item deletion is disabled by policy.');
  if (['create_item', 'update_item'].includes(action)) {
    const preview = { action, siteId: p.siteId, listId: p.listId, itemId: p.itemId ?? p.id, fields: trimObject(p.fields) };
    const gate = mutationGate(cfg, p, preview); if (gate.result) return gate.result;
    if (action === 'create_item') return ok(await graph.json('POST', `/sites/${site}/lists/${nonempty(list, 'listId')}/items`, { body: { fields: trimObject(p.fields) }, permission: P.sites }));
    const item = enc(nonempty(p.itemId ?? p.id, 'itemId'));
    return ok(await graph.json('PATCH', `/sites/${site}/lists/${nonempty(list, 'listId')}/items/${item}/fields`, { body: trimObject(p.fields), ifMatch: p.etag, permission: P.sites }));
  }
  const pages = `/sites/${site}/pages`;
  if (action === 'list_pages') return ok(await graph.page(`${pages}/microsoft.graph.sitePage?$select=id,name,title,webUrl,createdDateTime,lastModifiedDateTime,publishingState`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: pages, permission: P.sites }));
  if (action === 'create_page') {
    const input = trimObject(p.fields);
    const body = {
      ...input,
      name: nonempty(input.name, 'fields.name'),
      title: nonempty(input.title, 'fields.title'),
      pageLayout: String(input.pageLayout ?? '').trim() || 'article',
      '@odata.type': '#microsoft.graph.sitePage',
    };
    const gate = mutationGate(cfg, p, { action, siteId: p.siteId, page: body }); if (gate.result) return gate.result;
    return ok(await graph.json('POST', pages, { body, permission: P.sites }));
  }
  const page = enc(nonempty(p.pageId ?? p.id, 'pageId'));
  if (action === 'get_page') return ok(await graph.json('GET', `${pages}/${page}/microsoft.graph.sitePage?$expand=canvasLayout`, { permission: P.sites }));
  if (['update_page', 'publish_page'].includes(action)) {
    const body = trimObject(p.fields);
    const gate = mutationGate(cfg, p, { action, siteId: p.siteId, pageId: p.pageId ?? p.id, page: body }); if (gate.result) return gate.result;
    if (action === 'update_page') return ok(await graph.json('PATCH', `${pages}/${page}/microsoft.graph.sitePage`, { body, ifMatch: p.etag, permission: P.sites }));
    await graph.json('POST', `${pages}/${page}/microsoft.graph.sitePage/publish`, { body: {}, permission: P.sites });
    return ok({ published: true, pageId: p.pageId ?? p.id });
  }
  throw new TypeError(`Unknown MicrosoftSharePoint action: ${action}`);
}

function driveBase(p) { return p.driveId ? `/drives/${enc(p.driveId)}` : '/me/drive'; }

function safeUploadUrl(value) {
  const url = new URL(String(value ?? ''));
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !(host.endsWith('.up.1drv.com') || host.endsWith('.sharepoint.com') || host.endsWith('.onedrive.com'))) {
    throw new Error('Microsoft Graph returned an unsafe upload-session URL.');
  }
  return url;
}

async function uploadLargeFile(graph, parent, name, data) {
  const session = await graph.json('POST', `${parent}:/${enc(name)}:/createUploadSession`, {
    body: { item: { '@microsoft.graph.conflictBehavior': 'fail', name } }, permission: P.files,
  });
  const uploadUrl = safeUploadUrl(session?.uploadUrl);
  const chunkSize = 5 * 1024 * 1024; // 16 × Graph's required 320 KiB fragment quantum.
  let final = null;
  for (let start = 0; start < data.byteLength; start += chunkSize) {
    const end = Math.min(data.byteLength, start + chunkSize) - 1;
    const chunk = data.subarray(start, end + 1);
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'content-length': String(chunk.byteLength),
        'content-range': `bytes ${start}-${end}/${data.byteLength}`,
      },
      body: chunk,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Microsoft upload session refused bytes ${start}-${end} (${response.status}).`);
    const text = await response.text();
    if (text) {
      const parsed = JSON.parse(text);
      if (response.status === 200 || response.status === 201) final = parsed;
    }
  }
  if (!final) throw new Error('Microsoft upload session completed without a drive item.');
  return final;
}

function itemPath(p, suffix = '') {
  const base = driveBase(p);
  if (p.itemId || p.id) return `${base}/items/${enc(p.itemId ?? p.id)}${suffix}`;
  if (p.path) return `${base}/root:/${String(p.path).split('/').map(enc).join('/')}:${suffix}`;
  return `${base}/root${suffix}`;
}

async function files({ graph, cfg }, ctx, p) {
  const action = nonempty(p.action, 'action');
  if (action === 'search') return ok(await graph.page(`${driveBase(p)}/root/search(q='${enc(quoted(nonempty(p.query, 'query')))}')?$select=id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: driveBase(p), permission: P.files }));
  if (action === 'list') return ok(await graph.page(itemPath(p, '/children?$select=id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime'), { limit: limitOf(p), cursor: p.cursor, cursorPrefix: driveBase(p), permission: P.files }));
  if (action === 'get') return ok(await graph.json('GET', `${itemPath(p)}?$select=id,name,size,webUrl,file,folder,parentReference,lastModifiedDateTime,createdDateTime,eTag`, { permission: P.files }));
  if (action === 'read_text') {
    const file = await graph.binary(itemPath(p, '/content'), { maxBytes: 1024 * 1024, permission: P.files });
    if (!/^(text\/|application\/(json|xml|javascript|csv))/.test(file.contentType.toLowerCase())) throw new TypeError(`read_text does not support ${file.contentType}; use download with targetPath.`);
    return ok({ contentType: file.contentType, text: new TextDecoder().decode(file.body) });
  }
  if (action === 'download') {
    const target = nonempty(p.targetPath, 'targetPath');
    const root = ctx.currentWorkDir?.();
    if (!root) throw new Error('File download needs a project-bound turn.');
    const safe = ctx.host.projectFiles().safe(root, target, true);
    const maxBytes = Math.min(Math.max(Number(cfg.m365MaxTransferBytes) || 20 * 1024 * 1024, 1024), 250 * 1024 * 1024);
    const file = await graph.binary(itemPath(p, '/content'), { maxBytes, permission: P.files });
    await writeFile(safe, file.body);
    return ok({ saved: safe, bytes: file.body.byteLength, contentType: file.contentType });
  }
  if (action === 'upload') {
    const source = nonempty(p.path, 'path');
    const root = ctx.currentWorkDir?.();
    if (!root) throw new Error('File upload needs a project-bound turn.');
    const safe = ctx.host.projectFiles().safe(root, source, false);
    const data = await readFile(safe);
    const maxBytes = Math.min(Math.max(Number(cfg.m365MaxTransferBytes) || 20 * 1024 * 1024, 1024), 250 * 1024 * 1024);
    if (data.byteLength > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte Microsoft transfer limit.`);
    const name = nonempty(p.name, 'name');
    const parent = p.parentId ? `${driveBase(p)}/items/${enc(p.parentId)}` : `${driveBase(p)}/root`;
    const gate = mutationGate(cfg, p, { action, source: safe, bytes: data.byteLength, destination: `${parent}/${name}` }); if (gate.result) return gate.result;
    if (data.byteLength <= 4 * 1024 * 1024) {
      return ok(await graph.json('PUT', `${parent}:/${enc(name)}:/content`, { body: data, contentType: 'application/octet-stream', permission: P.files }));
    }
    return ok(await uploadLargeFile(graph, parent, name, data));
  }
  if (action === 'delete') throw new Error('Microsoft file deletion is disabled by policy.');
  const writes = ['create_folder', 'copy', 'move', 'rename', 'create_link', 'restore_version'];
  if (writes.includes(action)) {
    const gate = mutationGate(cfg, p, { action, itemId: p.itemId ?? p.id, name: p.name, destinationId: p.destinationId, linkType: p.linkType, scope: p.scope }); if (gate.result) return gate.result;
    if (action === 'create_folder') {
      return ok(await graph.json('POST', itemPath(p, '/children'), { body: { name: nonempty(p.name, 'name'), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }, permission: P.files }));
    }
    if (action === 'copy') return ok(await graph.json('POST', itemPath(p, '/copy'), { body: { parentReference: { id: nonempty(p.destinationId, 'destinationId') }, ...(p.name ? { name: p.name } : {}) }, permission: P.files }));
    if (action === 'move') return ok(await graph.json('PATCH', itemPath(p), { body: { parentReference: { id: nonempty(p.destinationId, 'destinationId') } }, ifMatch: p.etag, permission: P.files }));
    if (action === 'rename') return ok(await graph.json('PATCH', itemPath(p), { body: { name: nonempty(p.name, 'name') }, ifMatch: p.etag, permission: P.files }));
    if (action === 'create_link') return ok(await graph.json('POST', itemPath(p, '/createLink'), { body: { type: p.linkType || 'view', scope: p.scope || 'organization' }, permission: P.files }));
    return ok(await graph.json('POST', itemPath(p, `/versions/${enc(nonempty(p.id, 'version id'))}/restoreVersion`), { body: {}, permission: P.files }));
  }
  if (action === 'list_versions') return ok(await graph.page(itemPath(p, '/versions'), { limit: limitOf(p), cursor: p.cursor, cursorPrefix: driveBase(p), permission: P.files }));
  throw new TypeError(`Unknown MicrosoftFiles action: ${action}`);
}

function mailboxBase(p) { return p.userId ? `/users/${enc(p.userId)}` : '/me'; }
function recipients(values) { return (values ?? []).map((address) => ({ emailAddress: { address: String(address) } })); }
function messageBody(p) { return { contentType: String(p.bodyType ?? 'text').toUpperCase() === 'HTML' ? 'HTML' : 'Text', content: String(p.body ?? '') }; }

async function outlook({ graph, cfg }, p) {
  const resource = nonempty(p.resource, 'resource');
  const action = nonempty(p.action, 'action');
  const base = mailboxBase(p);
  if (resource === 'mail') {
    if (action === 'search' || action === 'list') {
      const select = '$select=id,subject,from,toRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,webLink,bodyPreview';
      const path = action === 'search'
        ? `${base}/messages?$search=${enc(`\"${nonempty(p.query, 'query')}\"`)}&${select}`
        : `${base}/messages?${select}&$orderby=receivedDateTime desc`;
      return ok(await graph.page(path, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}/messages`, permission: P.mail }));
    }
    if (action === 'get') {
      const data = await graph.json('GET', `${base}/messages/${enc(nonempty(p.messageId ?? p.id, 'messageId'))}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,webLink,body`, { permission: P.mail });
      if (data?.body?.content) data.body = { ...data.body, content: htmlToText(data.body.content) };
      return ok(data);
    }
    if (action === 'delete') throw new Error('Microsoft mail deletion is disabled by policy.');
    const draft = { subject: String(p.subject ?? ''), body: messageBody(p), toRecipients: recipients(p.to), ccRecipients: recipients(p.cc) };
    if (action === 'create_draft') {
      const gate = mutationGate(cfg, p, { action, mailbox: p.userId || 'me', subject: draft.subject, to: p.to ?? [], cc: p.cc ?? [] }); if (gate.result) return gate.result;
      return ok(await graph.json('POST', `${base}/messages`, { body: draft, permission: P.mail }));
    }
    if (action === 'send') {
      const gate = mutationGate(cfg, p, { action, mailbox: p.userId || 'me', subject: draft.subject, to: p.to ?? [], cc: p.cc ?? [] }); if (gate.result) return gate.result;
      await graph.json('POST', `${base}/sendMail`, { body: { message: draft, saveToSentItems: true }, permission: P.mail }); return ok({ sent: true });
    }
    const message = enc(nonempty(p.messageId ?? p.id, 'messageId'));
    if (action === 'send_draft') { const gate = mutationGate(cfg, p, { action, messageId: p.messageId ?? p.id }); if (gate.result) return gate.result; await graph.json('POST', `${base}/messages/${message}/send`, { body: {}, permission: P.mail }); return ok({ sent: true }); }
    if (action === 'reply' || action === 'forward') {
      const gate = mutationGate(cfg, p, { action, messageId: p.messageId ?? p.id, comment: p.comment ?? p.body, to: p.to ?? [] }); if (gate.result) return gate.result;
      const body = { comment: String(p.comment ?? p.body ?? ''), ...(action === 'forward' && p.to ? { toRecipients: recipients(p.to) } : {}) };
      await graph.json('POST', `${base}/messages/${message}/${action}`, { body, permission: P.mail }); return ok({ [action === 'reply' ? 'replied' : 'forwarded']: true });
    }
    if (action === 'move' || action === 'archive') {
      const destinationId = action === 'archive' ? 'archive' : nonempty(p.destinationId, 'destinationId');
      const gate = mutationGate(cfg, p, { action, messageId: p.messageId ?? p.id, destinationId }); if (gate.result) return gate.result;
      return ok(await graph.json('POST', `${base}/messages/${message}/move`, { body: { destinationId }, permission: P.mail }));
    }
  }
  if (resource === 'calendar') {
    if (action === 'list_calendars') return ok(await graph.page(`${base}/calendars?$select=id,name,color,canEdit,canShare,owner`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}/calendars`, permission: P.calendar }));
    const calendar = p.calendarId ? `/calendars/${enc(p.calendarId)}` : '/calendar';
    if (action === 'list_events') {
      const start = nonempty(p.start, 'start'); const end = nonempty(p.end, 'end');
      return ok(await graph.page(`${base}${calendar}/calendarView?startDateTime=${enc(start)}&endDateTime=${enc(end)}&$select=id,subject,start,end,location,organizer,attendees,isCancelled,webLink,bodyPreview`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}${calendar}/calendarView`, permission: P.calendar }));
    }
    if (action === 'get_event') return ok(await graph.json('GET', `${base}/events/${enc(nonempty(p.id, 'event id'))}`, { permission: P.calendar }));
    if (action === 'availability') {
      const schedules = p.to ?? p.attendees ?? [];
      return ok(await graph.json('POST', `${base}/calendar/getSchedule`, { body: { schedules, startTime: { dateTime: nonempty(p.start, 'start'), timeZone: nonempty(p.timeZone, 'timeZone') }, endTime: { dateTime: nonempty(p.end, 'end'), timeZone: nonempty(p.timeZone, 'timeZone') }, availabilityViewInterval: 30 }, permission: P.calendar }));
    }
    if (action === 'cancel_event') throw new Error('Microsoft calendar cancellation is disabled by policy.');
    if (action === 'create_event') {
      const eventBody = { subject: String(p.subject ?? ''), body: messageBody(p), start: { dateTime: nonempty(p.start, 'start'), timeZone: nonempty(p.timeZone, 'timeZone') }, end: { dateTime: nonempty(p.end, 'end'), timeZone: nonempty(p.timeZone, 'timeZone') }, attendees: (p.attendees ?? []).map((address) => ({ emailAddress: { address }, type: 'required' })) };
      const gate = mutationGate(cfg, p, { action, subject: p.subject, start: p.start, end: p.end, attendees: p.attendees ?? [] }); if (gate.result) return gate.result;
      return ok(await graph.json('POST', `${base}${calendar}/events`, { body: eventBody, permission: P.calendar }));
    }
    const event = enc(nonempty(p.id, 'event id'));
    if (action === 'update_event') { const gate = mutationGate(cfg, p, { action, eventId: p.id, changes: trimObject(p.fields) }); if (gate.result) return gate.result; return ok(await graph.json('PATCH', `${base}/events/${event}`, { body: trimObject(p.fields), ifMatch: p.etag, permission: P.calendar })); }
    if (action === 'respond_event') {
      const response = nonempty(p.response, 'response'); if (!['accept', 'decline', 'tentativelyAccept'].includes(response)) throw new TypeError('response must be accept, decline or tentativelyAccept.');
      const gate = mutationGate(cfg, p, { action, eventId: p.id, response, comment: p.comment }); if (gate.result) return gate.result;
      await graph.json('POST', `${base}/events/${event}/${response}`, { body: { comment: String(p.comment ?? ''), sendResponse: true }, permission: P.calendar }); return ok({ responded: response });
    }
  }
  if (resource === 'contacts') {
    if (action === 'list' || action === 'search') {
      const filter = action === 'search' ? `&$filter=${enc(`startswith(displayName,'${quoted(nonempty(p.query, 'query'))}')`)}` : '';
      return ok(await graph.page(`${base}/contacts?$select=id,displayName,givenName,surname,emailAddresses,businessPhones,mobilePhone,companyName${filter}`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${base}/contacts`, permission: P.contacts }));
    }
    if (action === 'get') return ok(await graph.json('GET', `${base}/contacts/${enc(nonempty(p.id, 'contact id'))}`, { permission: P.contacts }));
    if (action === 'delete') throw new Error('Microsoft contact deletion is disabled by policy.');
    if (['create', 'update'].includes(action)) {
      const body = trimObject(p.fields); const gate = mutationGate(cfg, p, { action, contactId: p.id, fields: body }); if (gate.result) return gate.result;
      if (action === 'create') return ok(await graph.json('POST', `${base}/contacts`, { body, permission: P.contacts }));
      const id = enc(nonempty(p.id, 'contact id'));
      return ok(await graph.json('PATCH', `${base}/contacts/${id}`, { body, ifMatch: p.etag, permission: P.contacts }));
    }
  }
  throw new TypeError(`Unknown MicrosoftOutlook resource/action: ${resource}/${action}`);
}

async function tasks({ graph, cfg }, p) {
  const service = nonempty(p.service, 'service'); const action = nonempty(p.action, 'action');
  if (service === 'todo') {
    const lists = '/me/todo/lists';
    if (action === 'list_lists') return ok(await graph.page(lists, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: lists, permission: P.tasks }));
    const list = enc(nonempty(p.taskListId ?? p.listId, 'taskListId'));
    const base = `${lists}/${list}/tasks`;
    if (action === 'list_tasks') return ok(await graph.page(base, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.tasks }));
    if (action === 'get') return ok(await graph.json('GET', `${base}/${enc(nonempty(p.id, 'task id'))}`, { permission: P.tasks }));
    if (action === 'delete') throw new Error('Microsoft To Do deletion is disabled by policy.');
    if (['create', 'update', 'complete'].includes(action)) {
      const changes = { ...trimObject(p.fields), ...(p.subject ? { title: p.subject } : {}), ...(action === 'complete' ? { status: 'completed' } : {}) };
      const gate = mutationGate(cfg, p, { action, service, taskListId: p.taskListId ?? p.listId, taskId: p.id, changes }); if (gate.result) return gate.result;
      if (action === 'create') return ok(await graph.json('POST', base, { body: changes, permission: P.tasks }));
      const id = enc(nonempty(p.id, 'task id'));
      return ok(await graph.json('PATCH', `${base}/${id}`, { body: changes, ifMatch: p.etag, permission: P.tasks }));
    }
  }
  if (service === 'planner') {
    if (action === 'list_plans') return ok(await graph.page('/me/planner/plans', { limit: limitOf(p), cursor: p.cursor, cursorPrefix: '/me/planner/plans', permission: P.planner }));
    if (action === 'list_buckets') { const plan = enc(nonempty(p.planId, 'planId')); return ok(await graph.page(`/planner/plans/${plan}/buckets`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/planner/plans/${plan}/buckets`, permission: P.planner })); }
    if (action === 'list_tasks') { const plan = enc(nonempty(p.planId, 'planId')); return ok(await graph.page(`/planner/plans/${plan}/tasks`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/planner/plans/${plan}/tasks`, permission: P.planner })); }
    if (action === 'get') return ok(await graph.json('GET', `/planner/tasks/${enc(nonempty(p.id, 'task id'))}`, { permission: P.planner }));
    if (action === 'delete_task') throw new Error('Microsoft Planner task deletion is disabled by policy.');
    if (['create_task', 'update_task', 'complete_task', 'create_bucket', 'update_bucket', 'create_plan'].includes(action)) {
      const changes = { ...trimObject(p.fields) };
      const bucketAction = action === 'create_bucket' || action === 'update_bucket';
      if (p.subject) changes[bucketAction ? 'name' : 'title'] = p.subject;
      if (p.bucketId) changes.bucketId = p.bucketId;
      if (p.planId) changes.planId = p.planId;
      if (p.assignments) changes.assignments = Object.fromEntries(p.assignments.map((id) => [id, { '@odata.type': '#microsoft.graph.plannerAssignment', orderHint: ' !' }]));
      if (action === 'complete_task') changes.percentComplete = 100;
      if (action === 'create_task') {
        changes.planId = nonempty(changes.planId, 'planId');
        changes.title = nonempty(changes.title, 'subject');
      }
      if (action === 'create_bucket') {
        changes.planId = nonempty(changes.planId, 'planId');
        changes.name = nonempty(changes.name, 'subject');
        changes.orderHint ??= ' !';
      }
      if (action === 'create_plan') {
        const groupId = nonempty(p.groupId, 'groupId');
        changes.title = nonempty(changes.title, 'subject');
        changes.container = { url: `https://graph.microsoft.com/v1.0/groups/${groupId}` };
      }
      const gate = mutationGate(cfg, p, { action, service, id: p.id, changes }); if (gate.result) return gate.result;
      if (action === 'create_task') return ok(await graph.json('POST', '/planner/tasks', { body: changes, permission: P.planner }));
      if (action === 'create_bucket') return ok(await graph.json('POST', '/planner/buckets', { body: changes, permission: P.planner }));
      if (action === 'create_plan') return ok(await graph.json('POST', '/planner/plans', { body: changes, permission: P.planner }));
      const id = enc(nonempty(p.id, 'id'));
      const kind = action === 'update_bucket' ? 'buckets' : 'tasks';
      return ok(await graph.json('PATCH', `/planner/${kind}/${id}`, { body: changes, ifMatch: nonempty(p.etag, 'etag'), permission: P.planner }));
    }
  }
  throw new TypeError(`Unknown MicrosoftTasks service/action: ${service}/${action}`);
}

async function oneNote({ graph, cfg }, p) {
  const action = nonempty(p.action, 'action'); const root = '/me/onenote';
  if (action === 'list_notebooks') return ok(await graph.page(`${root}/notebooks`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `${root}/notebooks`, permission: P.notes }));
  if (action === 'get_notebook') return ok(await graph.json('GET', `${root}/notebooks/${enc(nonempty(p.notebookId ?? p.id, 'notebookId'))}`, { permission: P.notes }));
  if (action === 'list_sections') {
    const base = p.notebookId ? `${root}/notebooks/${enc(p.notebookId)}/sections` : `${root}/sections`;
    return ok(await graph.page(base, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.notes }));
  }
  if (action === 'list_pages' || action === 'search_pages') {
    const base = p.sectionId ? `${root}/sections/${enc(p.sectionId)}/pages` : `${root}/pages`;
    const query = action === 'search_pages' ? `?$filter=${enc(`contains(title,'${quoted(nonempty(p.query, 'query'))}')`)}` : '';
    return ok(await graph.page(`${base}${query}`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.notes }));
  }
  if (action === 'get_page') {
    const id = enc(nonempty(p.pageId ?? p.id, 'pageId'));
    const meta = await graph.json('GET', `${root}/pages/${id}`, { permission: P.notes });
    const content = await graph.request('GET', `${root}/pages/${id}/content`, { accept: 'text/html', permission: P.notes }).then((r) => r.text());
    return ok({ ...meta, content: htmlToText(content) });
  }
  if (['create_notebook', 'create_section', 'create_page', 'update_page'].includes(action)) {
    const gate = mutationGate(cfg, p, { action, notebookId: p.notebookId, sectionId: p.sectionId, pageId: p.pageId ?? p.id, name: p.name, title: p.subject }); if (gate.result) return gate.result;
    if (action === 'create_notebook') return ok(await graph.json('POST', `${root}/notebooks`, { body: { displayName: nonempty(p.name, 'name') }, permission: P.notes }));
    if (action === 'create_section') return ok(await graph.json('POST', `${root}/notebooks/${enc(nonempty(p.notebookId, 'notebookId'))}/sections`, { body: { displayName: nonempty(p.name, 'name') }, permission: P.notes }));
    const html = String(p.body ?? '');
    if (action === 'create_page') {
      const response = await graph.request('POST', `${root}/sections/${enc(nonempty(p.sectionId, 'sectionId'))}/pages`, { body: html, contentType: 'text/html', accept: 'application/json', permission: P.notes });
      return ok(await response.json());
    }
    const operations = Array.isArray(p.fields?.operations) ? p.fields.operations : [];
    return ok(await graph.json('PATCH', `${root}/pages/${enc(nonempty(p.pageId ?? p.id, 'pageId'))}/content`, { body: operations, permission: P.notes }));
  }
  throw new TypeError(`Unknown MicrosoftOneNote action: ${action}`);
}

function workbookBase(p) { return `${driveBase(p)}/items/${enc(nonempty(p.itemId ?? p.id, 'itemId'))}/workbook`; }
async function excel({ graph, cfg, session }, p) {
  const action = nonempty(p.action, 'action');
  const itemId = nonempty(p.itemId ?? p.id, 'itemId');
  const base = workbookBase(p);
  const rawSession = workbookSession(p.session, session.subjectId, itemId);
  const headers = rawSession ? { 'workbook-session-id': rawSession } : {};
  if (action === 'list_worksheets') return ok(await graph.page(`${base}/worksheets`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.files }));
  if (action === 'list_tables') return ok(await graph.page(`${base}/tables`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.files }));
  if (action === 'list_names') return ok(await graph.page(`${base}/names`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: base, permission: P.files }));
  if (action === 'read_range') return ok(await graph.json('GET', `${base}/worksheets/${enc(nonempty(p.worksheet, 'worksheet'))}/range(address='${enc(quoted(nonempty(p.range, 'range')))}')`, { headers, permission: P.files }));
  if (['update_range', 'add_rows', 'create_table', 'calculate', 'create_session', 'close_session'].includes(action)) {
    const gate = mutationGate(cfg, p, { action, itemId: p.itemId ?? p.id, worksheet: p.worksheet, range: p.range, table: p.table, rows: p.values?.length }); if (gate.result) return gate.result;
    if (action === 'update_range') return ok(await graph.json('PATCH', `${base}/worksheets/${enc(nonempty(p.worksheet, 'worksheet'))}/range(address='${enc(quoted(nonempty(p.range, 'range')))}')`, { body: { ...(p.values ? { values: p.values } : {}), ...(p.formulas ? { formulas: p.formulas } : {}) }, headers, permission: P.files }));
    if (action === 'add_rows') return ok(await graph.json('POST', `${base}/tables/${enc(nonempty(p.table, 'table'))}/rows/add`, { body: { values: p.values ?? [] }, headers, permission: P.files }));
    if (action === 'create_table') return ok(await graph.json('POST', `${base}/worksheets/${enc(nonempty(p.worksheet, 'worksheet'))}/tables/add`, { body: { address: nonempty(p.range, 'range'), hasHeaders: true }, headers, permission: P.files }));
    if (action === 'calculate') { await graph.json('POST', `${base}/application/calculate`, { body: { calculationType: 'Full' }, headers, permission: P.files }); return ok({ calculated: true }); }
    if (action === 'create_session') {
      const created = await graph.json('POST', `${base}/createSession`, { body: { persistChanges: true }, permission: P.files });
      const id = nonempty(created?.id, 'Microsoft workbook session id');
      const handle = randomUUID();
      workbookSessions.set(handle, { id, subjectId: session.subjectId, itemId, expiresAt: Date.now() + WORKBOOK_SESSION_TTL_MS });
      return ok({ session: handle, expiresInSeconds: WORKBOOK_SESSION_TTL_MS / 1000 });
    }
    const handle = nonempty(p.session, 'session');
    await graph.json('POST', `${base}/closeSession`, { body: {}, headers: { 'workbook-session-id': nonempty(rawSession, 'session') }, permission: P.files });
    workbookSessions.delete(handle);
    return ok({ closed: true });
  }
  throw new TypeError(`Unknown MicrosoftExcel action: ${action}`);
}

async function teams({ graph, cfg }, p) {
  const action = nonempty(p.action, 'action');
  if (action === 'list_chats') return ok(await graph.page('/me/chats?$expand=members,lastMessagePreview&$orderby=lastMessagePreview/createdDateTime desc', { limit: limitOf(p), cursor: p.cursor, cursorPrefix: '/me/chats', permission: P.teams }));
  if (action === 'get_chat') return ok(await graph.json('GET', `/chats/${enc(nonempty(p.chatId ?? p.id, 'chatId'))}?$expand=members,lastMessagePreview`, { permission: P.teams }));
  if (action === 'list_chat_messages') { const chat = enc(nonempty(p.chatId, 'chatId')); return ok(await graph.page(`/chats/${chat}/messages`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/chats/${chat}/messages`, permission: P.teams })); }
  if (action === 'list_joined_teams') {
    if (p.cursor) throw new TypeError('Microsoft joined teams does not support pagination cursors.');
    const data = await graph.json('GET', '/me/joinedTeams?$select=id,displayName,description,webUrl,isArchived', { permission: P.teams });
    const items = Array.isArray(data?.value) ? data.value.slice(0, limitOf(p)) : [];
    return ok({ items, summary: `${items.length} joined teams` });
  }
  if (action === 'list_channels') { const team = enc(nonempty(p.teamId, 'teamId')); return ok(await graph.page(`/teams/${team}/channels?$select=id,displayName,description,webUrl,membershipType`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/teams/${team}/channels`, permission: P.teams })); }
  if (action === 'list_channel_messages') { const team = enc(nonempty(p.teamId, 'teamId')); const channel = enc(nonempty(p.channelId, 'channelId')); return ok(await graph.page(`/teams/${team}/channels/${channel}/messages`, { limit: limitOf(p), cursor: p.cursor, cursorPrefix: `/teams/${team}/channels/${channel}/messages`, permission: P.teams })); }
  if (['send_chat_message', 'reply_chat_message', 'send_channel_message', 'reply_channel_message', 'react'].includes(action)) {
    const gate = mutationGate(cfg, p, { action, chatId: p.chatId, teamId: p.teamId, channelId: p.channelId, messageId: p.messageId, body: p.body, reaction: p.status }); if (gate.result) return gate.result;
    const messageBody = { body: { contentType: String(p.bodyType ?? 'text').toLowerCase() === 'html' ? 'html' : 'text', content: nonempty(p.body, 'body') } };
    if (action === 'send_chat_message') return ok(await graph.json('POST', `/chats/${enc(nonempty(p.chatId, 'chatId'))}/messages`, { body: messageBody, permission: P.teams }));
    if (action === 'reply_chat_message') return ok(await graph.json('POST', `/chats/${enc(nonempty(p.chatId, 'chatId'))}/messages/${enc(nonempty(p.messageId, 'messageId'))}/replies`, { body: messageBody, permission: P.teams }));
    const root = `/teams/${enc(nonempty(p.teamId, 'teamId'))}/channels/${enc(nonempty(p.channelId, 'channelId'))}/messages`;
    if (action === 'send_channel_message') return ok(await graph.json('POST', root, { body: messageBody, permission: P.teams }));
    if (action === 'reply_channel_message') return ok(await graph.json('POST', `${root}/${enc(nonempty(p.messageId, 'messageId'))}/replies`, { body: messageBody, permission: P.teams }));
    return ok(await graph.json('POST', `/chats/${enc(nonempty(p.chatId, 'chatId'))}/messages/${enc(nonempty(p.messageId, 'messageId'))}/setReaction`, { body: { reactionType: nonempty(p.status, 'reaction type') }, permission: P.teams }));
  }
  throw new TypeError(`Unknown MicrosoftTeams action: ${action}`);
}
