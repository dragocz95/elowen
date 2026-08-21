import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, PlugZap, Plus, RefreshCw, Search, Server, Trash2, TriangleAlert, Wrench } from 'lucide-react';
import { apiJson, runtime, type McpScope, type McpServer, type McpServersResponse, type McpTransport } from './runtime';

/** One page of servers, matching the register size every workspace page in the app uses. */
const PAGE_SIZE = 20;

type ScopeFilter = 'all' | McpScope;

interface ServerDraft {
  scope: McpScope;
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  env: string;
  url: string;
  enabled: boolean;
}

const emptyDraft = (scope: McpScope): ServerDraft => ({
  scope, name: '', transport: 'stdio', command: '', args: '', env: '', url: '', enabled: true,
});

export function serverDraft(server: McpServer): ServerDraft {
  return {
    scope: server.scope,
    name: server.name,
    transport: server.transport,
    command: server.command ?? '',
    args: (server.args ?? []).join('\n'),
    env: Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
    url: server.url ?? '',
    enabled: server.enabled,
  };
}

export function parseEnvironment(value: string): Record<string, string> {
  return Object.fromEntries(value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return at < 1 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1)];
  }));
}

export function serverPayload(draft: ServerDraft) {
  return draft.transport === 'stdio'
    ? {
      scope: draft.scope, name: draft.name.trim(), transport: draft.transport, command: draft.command.trim(),
      args: draft.args.split('\n').map((line) => line.trim()).filter(Boolean), env: parseEnvironment(draft.env), enabled: draft.enabled,
    }
    : { scope: draft.scope, name: draft.name.trim(), transport: draft.transport, url: draft.url.trim(), enabled: draft.enabled };
}

/** Both ownership scopes as ONE register, personal first. The API already returns an empty `instance`
 *  list to a caller who may not manage instance servers, so flattening here discloses nothing the
 *  server did not already hand over. */
export function allServers(data: McpServersResponse): McpServer[] {
  return [...data.personal, ...data.instance];
}

/** A name is unique only WITHIN its ownership scope — the same server may exist personally and
 *  instance-wide — so every row identity, and the selection, is keyed by the pair. */
export function serverKey(server: { scope: McpScope; name: string }): string {
  return `${server.scope}:${server.name}`;
}

export function filterServers(servers: McpServer[], query: string, scope: ScopeFilter): McpServer[] {
  const needle = query.trim().toLowerCase();
  return servers.filter((server) => {
    if (scope !== 'all' && server.scope !== scope) return false;
    if (needle === '') return true;
    return `${server.name} ${server.transport} ${server.url ?? ''} ${server.command ?? ''}`.toLowerCase().includes(needle);
  });
}

function statusLabel(server: McpServer, strings: Record<string, string>): string {
  if (server.status === 'connected') return strings.statusConnected;
  if (server.status === 'error') return strings.statusError;
  if (server.status === 'disabled') return strings.statusDisabled;
  return strings.statusDisconnected;
}

function statusDot(server: McpServer): string {
  if (server.status === 'connected') return 'bg-success';
  if (server.status === 'error') return 'bg-danger';
  return 'bg-text-muted/50';
}

function scopeLabel(scope: McpScope, strings: Record<string, string>): string {
  return scope === 'instance' ? strings.scopeInstance : strings.scopePersonal;
}

/** One server = one register row. The connection state is the leading dot, the columns that only make
 *  sense on a wide workspace fold away as a unit, and everything that can be long is a single
 *  truncated line with the full value on hover — a wrapped cell would push every other row out of
 *  alignment. */
function McpServerRow({ server, showScope, selected, onSelect }: {
  server: McpServer;
  showScope: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('mcp');
  const label = statusLabel(server, s);
  return (
    <C.DataTableRow interactive selected={selected} aria-selected={selected} className="group">
      <C.DataTableCell className="flex items-center justify-center">
        <span className={`h-2 w-2 rounded-full ${statusDot(server)}`} title={label} aria-hidden />
        {/* The dot carries the state in colour alone. `title` is not reliably announced, so the state
            also travels as text a screen reader reads out with the row. */}
        <span className="sr-only">{label}</span>
      </C.DataTableCell>
      <C.DataTableCell>
        <button type="button" onClick={onSelect} className="flex w-full min-w-0 items-center gap-2 text-left">
          <span className="truncate text-sm text-text">{server.name}</span>
          {!server.enabled ? <C.Badge tone="muted">{s.statusDisabled}</C.Badge> : null}
        </button>
      </C.DataTableCell>
      <C.DataTableCell priority="wide" className="whitespace-nowrap">
        <C.Badge>{server.transport.toUpperCase()}</C.Badge>
      </C.DataTableCell>
      {showScope ? (
        <C.DataTableCell priority="wide" title={scopeLabel(server.scope, s)} className="truncate text-xs text-text-muted">
          {scopeLabel(server.scope, s)}
        </C.DataTableCell>
      ) : null}
      <C.DataTableCell priority="wide" className="whitespace-nowrap text-xs text-text-muted">
        <span className="flex items-center gap-1.5"><Wrench size={12} aria-hidden />{server.toolCount}</span>
      </C.DataTableCell>
      {/* A failure message is far longer than the column: one line, rest on hover. */}
      <C.DataTableCell priority="wide" title={server.lastError ?? label} className="truncate text-xs text-text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{server.lastError ? <TriangleAlert size={12} aria-hidden /> : <PlugZap size={12} aria-hidden />}</span>
          <span className={`truncate ${server.lastError ? 'text-danger' : ''}`}>{server.lastError ?? label}</span>
        </span>
      </C.DataTableCell>
      <C.DataTableCell aria-hidden className="text-text-muted/50 transition-colors group-hover:text-text"><ChevronRight size={15} /></C.DataTableCell>
    </C.DataTableRow>
  );
}

/** The selected server's editor, rendered in the workspace's detail drawer. `server` is the saved copy
 *  (it carries the live connection state and the bridged tools); `draft` is what the user is editing.
 *  A draft with no saved copy is a server being added. */
function ServerEditor({ server, draft, saving, busy, error, canManageInstance, onChange, onSave, onReconnect, onRemove }: {
  server?: McpServer;
  draft: ServerDraft;
  saving: boolean;
  busy: boolean;
  error?: string;
  canManageInstance: boolean;
  onChange: (next: ServerDraft) => void;
  onSave: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('mcp');
  return (
    <div className="flex flex-col gap-3">
      {server ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <C.Badge>{server.transport.toUpperCase()}</C.Badge>
            <C.Badge tone={server.status === 'connected' ? 'accent' : server.status === 'error' ? 'danger' : 'muted'}>{statusLabel(server, s)}</C.Badge>
            <C.Badge tone="muted">{scopeLabel(server.scope, s)}</C.Badge>
          </div>
          {server.lastError ? <p className="text-xs text-danger">{server.lastError}</p> : null}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <C.Field label={s.name} htmlFor="mcp-name">
          {/* The name is the row's identity in its scope: renaming it would be a different server. */}
          <C.Input id="mcp-name" value={draft.name} disabled={Boolean(server)} onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draft, name: event.target.value })} />
        </C.Field>
        <C.Field label={s.scope} hint={s.scopeHelp}>
          <C.SelectMenu
            label={s.scope}
            value={draft.scope}
            onChange={(scope: McpScope) => onChange({ ...draft, scope })}
            options={[
              { value: 'personal', label: s.scopePersonal },
              ...(canManageInstance ? [{ value: 'instance', label: s.scopeInstance }] : []),
            ]}
          />
        </C.Field>
        <div className="sm:col-span-2">
          <C.Field label={s.transport}>
            <C.SelectMenu
              label={s.transport}
              value={draft.transport}
              onChange={(transport: McpTransport) => onChange({ ...draft, transport })}
              options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }]}
            />
          </C.Field>
        </div>
        {draft.transport === 'stdio' ? (
          <>
            <div className="sm:col-span-2">
              <C.Field label={s.command} hint={s.commandHelp}>
                <C.Input value={draft.command} onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draft, command: event.target.value })} />
              </C.Field>
            </div>
            <C.Field label={s.arguments}>
              <textarea className="min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text" value={draft.args} onChange={(event) => onChange({ ...draft, args: event.target.value })} />
            </C.Field>
            <C.Field label={s.environment}>
              <textarea className="min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text" value={draft.env} onChange={(event) => onChange({ ...draft, env: event.target.value })} />
            </C.Field>
          </>
        ) : (
          <div className="sm:col-span-2">
            <C.Field label={s.url} htmlFor="mcp-url">
              <C.Input id="mcp-url" value={draft.url} onChange={(event: React.ChangeEvent<HTMLInputElement>) => onChange({ ...draft, url: event.target.value })} />
            </C.Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <C.Toggle checked={draft.enabled} onChange={(enabled: boolean) => onChange({ ...draft, enabled })} label={s.enabled} />
        </div>
      </div>

      {server ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{s.toolsCount.replace('{n}', String(server.toolCount))}</span>
          {server.tools.length === 0
            ? <p className="text-xs text-text-muted">{s.noTools}</p>
            : (
              <ul className="flex flex-col gap-1">
                {server.tools.map((tool) => (
                  <li key={tool.name} title={tool.description} className="truncate font-mono text-xs text-text-muted">{tool.title || tool.name}</li>
                ))}
              </ul>
            )}
        </div>
      ) : null}

      {error ? <p className="text-sm text-danger" role="alert">{error}</p> : null}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        {server
          ? <C.Button variant="ghost-danger" icon={Trash2} onClick={onRemove} disabled={busy}>{s.removeServer}</C.Button>
          : <span />}
        <div className="flex flex-wrap items-center gap-2">
          {server ? <C.Button variant="ghost" icon={RefreshCw} onClick={onReconnect} disabled={busy}>{s.reconnectServer}</C.Button> : null}
          <C.Button variant="accent" onClick={onSave} disabled={busy}>{saving ? s.saving : s.save}</C.Button>
        </div>
      </div>
    </div>
  );
}

/** MCP manager (the mcp plugin's own page): every server this account may see — its own and, for the
 *  instance owner, the shared ones — as one register, with the selected server's editor in the
 *  workspace's detail drawer. */
export function McpServersPage() {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('mcp');
  const { t } = hooks.useTranslation();
  const [data, setData] = useState<McpServersResponse>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [page, setPage] = useState(0);
  /** The open editor: the key of the server it belongs to (null = a server being added) and its draft. */
  const [editor, setEditor] = useState<{ key: string | null; draft: ServerDraft }>();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [removing, setRemoving] = useState<McpServer>();

  const load = useCallback(async () => {
    setLoading(true); setLoadError(false);
    try { setData(await apiJson<McpServersResponse>('/plugins/mcp/api/servers')); }
    catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const canManageInstance = data?.canManageInstance === true;
  const rows = useMemo(() => (data ? allServers(data) : []), [data]);
  const filtered = useMemo(() => filterServers(rows, query, scope), [rows, query, scope]);
  // A narrowed list can be shorter than the page the user is on; landing on an empty page reads as
  // "nothing matches" when the matches are simply on page 1.
  useEffect(() => { setPage(0); }, [query, scope]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(() => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE), [filtered, clampedPage]);

  const connected = rows.filter((server) => server.status === 'connected').length;
  const failing = rows.filter((server) => server.status === 'error').length;
  const bridged = rows.reduce((total, server) => total + server.toolCount, 0);

  // The editor's saved copy is looked up in the CURRENT data on every render, so a reload (after a save
  // or a reconnect) refreshes the connection state and the tool list under the open drawer.
  const selected = editor?.key != null ? rows.find((server) => serverKey(server) === editor.key) : undefined;
  const closeEditor = () => { setEditor(undefined); setActionError(undefined); };

  const save = async () => {
    if (!editor) return;
    setSaving(true); setBusy(true); setActionError(undefined);
    try {
      const path = selected ? `/plugins/mcp/api/servers/${encodeURIComponent(selected.name)}` : '/plugins/mcp/api/servers';
      await apiJson(path, {
        method: selected ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverPayload(editor.draft)),
      });
      setEditor(undefined);
      await load();
    } catch { setActionError(s.saveError); }
    finally { setSaving(false); setBusy(false); }
  };

  const reconnect = async () => {
    if (!selected) return;
    setBusy(true); setActionError(undefined);
    try {
      await apiJson('/plugins/mcp/api/reconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: selected.scope, name: selected.name }),
      });
      await load();
    } catch { setActionError(s.actionError); }
    finally { setBusy(false); }
  };

  const removeServer = async () => {
    const target = removing;
    setRemoving(undefined);
    if (!target) return;
    setBusy(true); setActionError(undefined);
    try {
      await apiJson(`/plugins/mcp/api/servers/${encodeURIComponent(target.name)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: target.scope }),
      });
      setEditor(undefined);
      await load();
    } catch { setActionError(s.actionError); }
    finally { setBusy(false); }
  };

  const openServer = (server: McpServer) => { setActionError(undefined); setEditor({ key: serverKey(server), draft: serverDraft(server) }); };
  const addServer = () => { setActionError(undefined); setEditor({ key: null, draft: emptyDraft('personal') }); };
  const addButton = <C.Button variant="accent" icon={Plus} onClick={addServer}>{s.addServer}</C.Button>;

  const table = (
    <div className="flex min-w-0 flex-col gap-3">
      <C.DataTable
        ariaLabel={s.title}
        columns={canManageInstance ? '2rem minmax(0,1fr) 6rem 7rem 5rem minmax(0,10rem) 1.25rem' : '2rem minmax(0,1fr) 6rem 5rem minmax(0,10rem) 1.25rem'}
        compactColumns="2rem minmax(0,1fr) 1.25rem"
      >
        <C.DataTableRow header>
          <C.DataTableCell header><span className="sr-only">{s.colStatus}</span></C.DataTableCell>
          <C.DataTableCell header>{s.name}</C.DataTableCell>
          <C.DataTableCell header priority="wide">{s.transport}</C.DataTableCell>
          {canManageInstance ? <C.DataTableCell header priority="wide">{s.scope}</C.DataTableCell> : null}
          <C.DataTableCell header priority="wide">{s.tools}</C.DataTableCell>
          <C.DataTableCell header priority="wide" className="whitespace-nowrap">{s.colStatus}</C.DataTableCell>
          <C.DataTableCell header role="presentation" aria-hidden>{null}</C.DataTableCell>
        </C.DataTableRow>
        {pageItems.map((server) => (
          <McpServerRow
            key={serverKey(server)}
            server={server}
            showScope={canManageInstance}
            selected={editor?.key === serverKey(server)}
            onSelect={() => openServer(server)}
          />
        ))}
      </C.DataTable>

      <div className="flex flex-col gap-2 border-b border-border/80 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="font-mono text-xs text-text-muted">
          {s.pageRange
            .replace('{from}', String(clampedPage * PAGE_SIZE + 1))
            .replace('{to}', String(clampedPage * PAGE_SIZE + pageItems.length))
            .replace('{total}', String(filtered.length))}
        </span>
        <div className="flex items-center gap-1">
          <C.Button variant="ghost" icon={ChevronLeft} disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>{s.prevPage}</C.Button>
          <span className="min-w-24 text-center font-mono text-xs text-text-muted">
            {s.pageLabel.replace('{page}', String(clampedPage + 1)).replace('{pages}', String(pageCount))}
          </span>
          <C.Button variant="ghost" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{s.nextPage}<ChevronRight size={15} className="ml-1" aria-hidden /></C.Button>
        </div>
      </div>
    </div>
  );

  return (
    <C.SpatialWorkspaceLayout
      hero={{
        eyebrow: t.pluginUi.eyebrow,
        title: s.title,
        count: rows.length,
        description: s.description,
        mascotState: loadError ? 'error' : loading ? 'saving' : 'idle',
        status: !loading && !loadError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={s.statusConnected} value={connected} icon={PlugZap} />
          <C.WorkspaceMetric label={s.statusError} value={failing} icon={TriangleAlert} />
          <C.WorkspaceMetric label={s.tools} value={bridged} icon={Wrench} />
        </>,
      }}
    >
      <C.ControlSurfaceDocument>
        {/* Error before loading: a failed load leaves `data` undefined, so testing the loading branch
            first would swallow the failure and never offer Retry. */}
        {loadError ? <C.ControlSurfaceState tone="danger"><C.ErrorState message={s.loadError} onRetry={() => void load()} /></C.ControlSurfaceState>
          : loading || !data ? <C.ControlSurfaceState><C.LoadingState variant="cards" /></C.ControlSurfaceState>
          : (
            <div className="flex min-w-0 flex-col gap-4">
              <C.ControlSurfaceToolbar className="flex-col items-stretch">
                <div className="flex min-w-0 flex-wrap items-center gap-2 py-3">
                  <div className="relative min-w-[15rem] flex-1">
                    <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                    <C.Input value={query} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} placeholder={s.searchPlaceholder} className="pl-9" />
                  </div>
                  {/* Only the instance owner ever sees more than one ownership scope, so only he is
                      offered the filter that narrows to one. */}
                  {canManageInstance ? (
                    <C.Segmented
                      value={scope}
                      onChange={(value: string) => setScope(value as ScopeFilter)}
                      options={[{ value: 'all', label: s.filterAll }, { value: 'personal', label: s.scopePersonal }, { value: 'instance', label: s.scopeInstance }]}
                      aria-label={s.scope}
                      nowrap
                    />
                  ) : null}
                </div>
              </C.ControlSurfaceToolbar>

              <C.ControlSurfaceRegister className="flex flex-col gap-4">
                {rows.length === 0
                  ? <C.EmptyState title={s.empty} icon={Server} action={addButton} />
                  : filtered.length === 0
                    ? <C.EmptyState title={s.emptySearch} icon={Search} />
                    : table}
              </C.ControlSurfaceRegister>
            </div>
          )}
      </C.ControlSurfaceDocument>

      {editor ? (
        <C.WorkspaceDetailRail label={selected ? selected.name : s.addServer} closeLabel={t.common.close} onClose={closeEditor}>
          <ServerEditor
            server={selected}
            draft={editor.draft}
            saving={saving}
            busy={busy}
            error={actionError}
            canManageInstance={canManageInstance}
            onChange={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
            onSave={() => void save()}
            onReconnect={() => void reconnect()}
            onRemove={() => { if (selected) setRemoving(selected); }}
          />
        </C.WorkspaceDetailRail>
      ) : null}

      <C.ConfirmDialog
        open={Boolean(removing)}
        title={removing ? s.removeConfirm.replace('{name}', removing.name) : ''}
        confirmLabel={s.removeServer}
        onClose={() => setRemoving(undefined)}
        onConfirm={() => void removeServer()}
      />
    </C.SpatialWorkspaceLayout>
  );
}
