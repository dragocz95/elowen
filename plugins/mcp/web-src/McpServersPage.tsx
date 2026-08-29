import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, PlugZap, Plus, RefreshCw, Search, Server, Trash2, TriangleAlert, Wrench } from 'lucide-react';
import {
  apiJson, runtime, DATA_TABLE_ICON_SIZE,
  type McpScope, type McpServer, type McpServersResponse, type McpTransport, type PageFilterField,
} from './runtime';

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
  if (server.status === 'error') return 'bg-destructive';
  return 'bg-muted-foreground/50';
}

function scopeLabel(scope: McpScope, strings: Record<string, string>): string {
  return scope === 'instance' ? strings.scopeInstance : strings.scopePersonal;
}

/** One server = one register row. The connection state is the leading dot, the columns that only make
 *  sense on a wide workspace fold away as a unit, and everything that can be long is a single
 *  truncated line with the full value on hover — a wrapped cell would push every other row out of
 *  alignment.
 *
 *  Opening the editor is the ROW's contract (`onOpen` + a short `openLabel`), not a button around the
 *  name: one tab stop per row, a target the width of the row, and an accessible name that says what
 *  activating it does rather than repeating the server name alone. */
function McpServerRow({ server, showScope, selected, onOpen }: {
  server: McpServer;
  showScope: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('mcp');
  const label = statusLabel(server, s);
  return (
    <C.DataTableRow
      selected={selected}
      aria-selected={selected}
      onOpen={onOpen}
      openLabel={s.openServer.replace('{name}', server.name)}
    >
      <C.DataTableCell lines="auto" title={label} className="flex items-center justify-center">
        <span className={`h-2 w-2 rounded-full ${statusDot(server)}`} aria-hidden />
        {/* The dot carries the state in colour alone. `title` is not reliably announced, so the state
            also travels as text a screen reader reads out with the row. */}
        <span className="sr-only">{label}</span>
      </C.DataTableCell>
      <C.DataTableCell lines={1} title={server.name}>
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{server.name}</span>
          {!server.enabled ? <C.Badge tone="muted">{s.statusDisabled}</C.Badge> : null}
        </span>
      </C.DataTableCell>
      <C.DataTableCell priority="wide" lines="auto" className="whitespace-nowrap">
        <C.Badge>{server.transport.toUpperCase()}</C.Badge>
      </C.DataTableCell>
      {showScope ? (
        <C.DataTableCell priority="wide" lines={1} className="text-xs text-muted-foreground">
          {scopeLabel(server.scope, s)}
        </C.DataTableCell>
      ) : null}
      <C.DataTableCell priority="wide" lines={1} className="text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><Wrench size={DATA_TABLE_ICON_SIZE} aria-hidden />{server.toolCount}</span>
      </C.DataTableCell>
      {/* A failure message is far longer than the column: one line, rest on hover. */}
      <C.DataTableCell priority="wide" lines={1} title={server.lastError ?? label} className="text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">{server.lastError ? <TriangleAlert size={DATA_TABLE_ICON_SIZE} aria-hidden /> : <PlugZap size={DATA_TABLE_ICON_SIZE} aria-hidden />}</span>
          <span className={`truncate ${server.lastError ? 'text-destructive' : ''}`}>{server.lastError ?? label}</span>
        </span>
      </C.DataTableCell>
      <C.DataTableChevronCell />
    </C.DataTableRow>
  );
}

/** The selected server's editor, rendered in the workspace's detail drawer. `server` is the saved copy
 *  (it carries the live connection state and the bridged tools); `draft` is what the user is editing.
 *  A draft with no saved copy is a server being added. */
function ServerEditor({ server, draft, saving, busy, error, canManageInstance, onChange, onSave, onReconnect, onRemove, onShowTools }: {
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
  onShowTools: () => void;
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
          {server.lastError ? <p className="text-xs text-destructive">{server.lastError}</p> : null}
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
              <textarea className="min-h-24 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground" value={draft.args} onChange={(event) => onChange({ ...draft, args: event.target.value })} />
            </C.Field>
            <C.Field label={s.environment}>
              <textarea className="min-h-24 rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs text-foreground" value={draft.env} onChange={(event) => onChange({ ...draft, env: event.target.value })} />
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

      {/* The bridged tools are a read-only fact about the server, so they wear the app's managed-
          selection summary in its display-only mode: a count line with a few sample chips here, the
          whole list behind the modal. Presented exactly like the tool access on a user's detail —
          same caption block, same framed summary — because it is the same kind of thing being read.
          A server with nothing bridged still gets the caption, so the block does not vanish. */}
      {server ? (
        <C.DetailBlock icon={Wrench} title={s.tools} hint={s.toolsHint}>
          {server.tools.length === 0
            ? <p className="text-xs text-muted-foreground">{s.noTools}</p>
            : (
              <C.SelectionSummary
                readOnly
                countText={s.toolsCount.replace('{n}', String(server.tools.length))}
                samples={server.tools.slice(0, 3).map((tool) => ({
                  label: tool.title || tool.name,
                  // Bridged tools carry no icon of their own, so they all wear the generic wrench the
                  // user detail falls back to — the chips stay aligned with the ones there.
                  icon: <Wrench size={12} className="inline" />,
                }))}
                moreCount={Math.max(0, server.tools.length - 3)}
                onManage={onShowTools}
                manageLabel={s.viewTools}
                manageAriaLabel={`${s.viewTools}: ${server.name}`}
              />
            )}
        </C.DetailBlock>
      ) : null}

      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}

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
  const { components: C, hooks, utils } = runtime();
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
  const [showTools, setShowTools] = useState(false);

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
  const closeEditor = () => { setEditor(undefined); setActionError(undefined); setShowTools(false); };

  const save = async () => {
    if (!editor) return;
    setSaving(true); setBusy(true); setActionError(undefined);
    try {
      // Changing the scope is a MOVE, not a field edit: PATCH resolves the server in the scope it is
      // ASKED for, so a request carrying the new scope reads to it as a server that does not exist.
      // The move runs FIRST because it is the step that can be refused on its own — a name already
      // taken in the target scope, or a local-process server — and a refusal has to leave the server
      // exactly where it was rather than edited into a scope it never reached.
      if (selected && editor.draft.scope !== selected.scope) {
        await apiJson('/plugins/mcp/api/transfer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fromScope: selected.scope, name: selected.name, toScope: editor.draft.scope }),
        });
      }
      const path = selected ? `/plugins/mcp/api/servers/${encodeURIComponent(selected.name)}` : '/plugins/mcp/api/servers';
      await apiJson(path, {
        method: selected ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(serverPayload(editor.draft)),
      });
      setEditor(undefined);
      await load();
    } catch (error) {
      // Show what the daemon actually refused — a collision and a local-process server are different
      // problems and the user can only act on the difference.
      setActionError(utils.apiErrorMessage(error) || s.saveError);
      // A move that landed before a later step failed already changed the register, so re-read it
      // instead of leaving the page asserting a scope the server no longer has.
      await load();
    }
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

  // The register's controls belong to the PAGE, so they sit in the canonical toolbar row the shell draws
  // under the hero rather than in a band this bundle lays out inside its own content. They appear only
  // once the servers are in: a search field over a skeleton narrows nothing, and a failed load owes the
  // reader Retry instead of a filter.
  const ready = !loading && !loadError && data !== undefined;
  const searchField = (
    <C.RegisterSearch
      value={query}
      onChange={setQuery}
      placeholder={s.searchPlaceholder}
      label={s.searchPlaceholder}
      onClear={() => setQuery('')}
      clearLabel={s.searchClear}
    />
  );
  const scopeControl = (
    <C.Segmented
      value={scope}
      onChange={(value: string) => setScope(value as ScopeFilter)}
      options={[{ value: 'all', label: s.filterAll }, { value: 'personal', label: s.scopePersonal }, { value: 'instance', label: s.scopeInstance }]}
      aria-label={s.scope}
      nowrap
    />
  );
  // The chip has to name WHICH filter is on — "Personal" alone would not say what it narrows — so it
  // carries the field's own label ahead of the value.
  const scopeField: PageFilterField = scope === 'all'
    ? { id: 'scope', label: s.scope, control: scopeControl, active: false }
    : {
      id: 'scope', label: s.scope, control: scopeControl, active: true,
      activeLabel: `${s.scope}: ${scopeLabel(scope, s)}`,
      onReset: () => setScope('all'),
    };
  // Only the instance owner ever sees more than one ownership scope, so only he is offered the filter
  // that narrows to one. Everyone else hands the toolbar an EMPTY field set, which draws no trigger at
  // all — a page with nothing to filter must not carry a control that opens an empty panel.
  const filters = ready && canManageInstance ? [scopeField] : [];

  const table = (
    <div className="flex min-w-0 flex-col gap-3">
      <C.DataTable
        ariaLabel={s.title}
        columns={canManageInstance ? '2rem minmax(0,1fr) 6rem 7rem 5rem minmax(0,10rem) 1.25rem' : '2rem minmax(0,1fr) 6rem 5rem minmax(0,10rem) 1.25rem'}
        compactColumns="2rem minmax(0,1fr) 1.25rem"
      >
        <C.DataTableRow header>
          {/* Both this column and the one carrying the failure text state the connection. Only one of
              them can be called "Status" out loud, so the dot column's name is for assistive
              technology alone rather than a second visible header with the same word. */}
          <C.DataTableCell header labelHidden lines={1}>{s.colStatus}</C.DataTableCell>
          <C.DataTableCell header lines={1}>{s.name}</C.DataTableCell>
          <C.DataTableCell header priority="wide" lines={1}>{s.transport}</C.DataTableCell>
          {canManageInstance ? <C.DataTableCell header priority="wide" lines={1}>{s.scope}</C.DataTableCell> : null}
          <C.DataTableCell header priority="wide" lines={1}>{s.tools}</C.DataTableCell>
          <C.DataTableCell header priority="wide" lines={1}>{s.colStatus}</C.DataTableCell>
          {/* The chevron track carries no header: its cell is decorative. */}
        </C.DataTableRow>
        {pageItems.map((server) => (
          <McpServerRow
            key={serverKey(server)}
            server={server}
            showScope={canManageInstance}
            selected={editor?.key === serverKey(server)}
            onOpen={() => openServer(server)}
          />
        ))}
      </C.DataTable>

      <C.Pager page={clampedPage} pageSize={PAGE_SIZE} total={filtered.length} onPageChange={setPage} ariaLabel={s.title} />
    </div>
  );

  return (
    <C.WorkspaceShell
      variant="register"
      hero={{
        eyebrow: t.pluginUi.eyebrow,
        title: s.title,
        count: rows.length,
        description: s.description,
        icon: Blocks,
        mascot: loadError ? 'error' : loading ? 'saving' : 'idle',
        status: !loading && !loadError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={s.statusConnected} value={connected} icon={PlugZap} />
          <C.WorkspaceMetric label={s.statusError} value={failing} icon={TriangleAlert} />
          <C.WorkspaceMetric label={s.tools} value={bridged} icon={Wrench} />
        </>,
      }}
      toolbar={{ search: ready ? searchField : undefined, filters }}
    >
      <C.ControlSurfaceDocument>
        {/* Error before loading: a failed load leaves `data` undefined, so testing the loading branch
            first would swallow the failure and never offer Retry. */}
        {loadError ? <C.ControlSurfaceState tone="danger"><C.ErrorState message={s.loadError} onRetry={() => void load()} /></C.ControlSurfaceState>
          : loading || !data ? <C.ControlSurfaceState><C.LoadingState variant="cards" /></C.ControlSurfaceState>
          : (
            <C.ControlSurfaceRegister className="flex flex-col gap-4">
              {rows.length === 0
                ? <C.EmptyState title={s.empty} icon={Server} action={addButton} />
                : filtered.length === 0
                  ? <C.EmptyState title={s.emptySearch} icon={Search} />
                  : table}
            </C.ControlSurfaceRegister>
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
            onShowTools={() => setShowTools(true)}
          />
        </C.WorkspaceDetailRail>
      ) : null}

      {/* Display-only: every bridged tool, its description on hover, and nothing to change. */}
      <C.ManageSelectionModal
        readOnly
        open={showTools && (selected?.tools.length ?? 0) > 0}
        title={s.tools}
        subtitle={selected?.name}
        onClose={() => setShowTools(false)}
        items={(selected?.tools ?? []).map((tool) => ({
          id: tool.name,
          label: tool.title || tool.name,
          group: '',
          disabledHint: tool.description,
        }))}
        countLabel={(n: number) => s.toolsCount.replace('{n}', String(n))}
      />

      <C.ConfirmDialog
        open={Boolean(removing)}
        title={removing ? s.removeConfirm.replace('{name}', removing.name) : ''}
        confirmLabel={s.removeServer}
        onClose={() => setRemoving(undefined)}
        onConfirm={() => void removeServer()}
      />
    </C.WorkspaceShell>
  );
}
