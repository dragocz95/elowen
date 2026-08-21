import { useCallback, useEffect, useMemo, useState } from 'react';
import { Blocks, PlugZap, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { apiJson, runtime, type McpScope, type McpServer, type McpServersResponse, type McpTransport } from './runtime';

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

function statusLabel(server: McpServer, strings: Record<string, string>): string {
  if (server.status === 'connected') return strings.statusConnected;
  if (server.status === 'error') return strings.statusError;
  if (server.status === 'disabled') return strings.statusDisabled;
  return strings.statusDisconnected;
}

function ServerCard({ server, strings, onEdit, onRemove, onReconnect, onTools }: {
  server: McpServer;
  strings: Record<string, string>;
  onEdit: () => void;
  onRemove: () => void;
  onReconnect: () => void;
  onTools: () => void;
}) {
  const { Button, Badge, SelectionSummary } = runtime().components;
  const samples = server.tools.slice(0, 3).map((tool) => ({ label: tool.title || tool.name }));
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4" style={{ boxShadow: 'var(--shadow-card)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted"><Server size={17} /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium text-text">{server.name}</h3>
              <Badge>{server.transport.toUpperCase()}</Badge>
              <Badge tone={server.status === 'connected' ? 'accent' : 'muted'}>{statusLabel(server, strings)}</Badge>
            </div>
            {server.lastError ? <p className="mt-1 text-xs text-danger">{server.lastError}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onReconnect}><RefreshCw size={13} />{strings.reconnectServer}</Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>{strings.editServer}</Button>
          <Button size="sm" variant="ghost" onClick={onRemove}><Trash2 size={13} />{strings.removeServer}</Button>
        </div>
      </div>
      <SelectionSummary
        variant="line"
        countText={strings.toolsCount.replace('{n}', String(server.toolCount))}
        samples={samples}
        moreCount={Math.max(0, server.tools.length - samples.length)}
        onManage={onTools}
        manageLabel={strings.viewTools}
        manageAriaLabel={`${strings.viewTools}: ${server.name}`}
      />
    </div>
  );
}

function ServerForm({ draft, editing, strings, saving, error, onChange, onSave, onClose, canManageInstance }: {
  draft: ServerDraft;
  editing: boolean;
  strings: Record<string, string>;
  saving: boolean;
  error?: string;
  onChange: (next: ServerDraft) => void;
  onSave: () => void;
  onClose: () => void;
  canManageInstance: boolean;
}) {
  const { Modal, ModalBody, ModalFooter, Button, Input, Field, HelpTip, Toggle, SelectMenu } = runtime().components;
  return (
    <Modal title={editing ? strings.editServer : strings.addServer} onClose={onClose} size="md" icon={PlugZap}>
      <ModalBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={strings.name} htmlFor="mcp-name"><Input id="mcp-name" value={draft.name} disabled={editing} onChange={(event: any) => onChange({ ...draft, name: event.target.value })} /></Field>
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">{strings.scope}<HelpTip align="left">{strings.scopeHelp}</HelpTip></span>
            <SelectMenu label={strings.scope} value={draft.scope} onChange={(scope: McpScope) => onChange({ ...draft, scope })} options={[
              { value: 'personal', label: strings.scopePersonal },
              ...(canManageInstance ? [{ value: 'instance', label: strings.scopeInstance }] : []),
            ]} />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{strings.transport}</span>
            <SelectMenu label={strings.transport} value={draft.transport} onChange={(transport: McpTransport) => onChange({ ...draft, transport })} options={[
              { value: 'stdio', label: 'stdio' }, { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' },
            ]} />
          </div>
          {draft.transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">{strings.command}<HelpTip align="left">{strings.commandHelp}</HelpTip></span>
                <Input value={draft.command} onChange={(event: any) => onChange({ ...draft, command: event.target.value })} />
              </div>
              <Field label={strings.arguments}><textarea className="min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text" value={draft.args} onChange={(event) => onChange({ ...draft, args: event.target.value })} /></Field>
              <Field label={strings.environment}><textarea className="min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text" value={draft.env} onChange={(event) => onChange({ ...draft, env: event.target.value })} /></Field>
            </>
          ) : <Field label={strings.url} htmlFor="mcp-url"><Input id="mcp-url" value={draft.url} onChange={(event: any) => onChange({ ...draft, url: event.target.value })} /></Field>}
          <div className="sm:col-span-2"><Toggle checked={draft.enabled} onChange={(enabled: boolean) => onChange({ ...draft, enabled })} label={strings.enabled} /></div>
          {error ? <p className="text-sm text-danger sm:col-span-2" role="alert">{error}</p> : null}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{strings.cancel}</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? strings.saving : strings.save}</Button>
      </ModalFooter>
    </Modal>
  );
}

export function McpServersPage({ surface }: { surface: 'page' | 'deck' }) {
  const { PluginPageHeader, SettingsDocument, SettingsGroup, Button, LoadingState, ErrorState, EmptyState, ConfirmDialog, ManageSelectionModal } = runtime().components;
  const strings = runtime().hooks.usePluginStrings('mcp');
  const [data, setData] = useState<McpServersResponse>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<ServerDraft>();
  const [editingName, setEditingName] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [remove, setRemove] = useState<McpServer>();
  const [tools, setTools] = useState<McpServer>();

  const load = useCallback(async () => {
    setLoading(true); setLoadError(false);
    try { setData(await apiJson<McpServersResponse>('/plugins/mcp/api/servers')); }
    catch { setLoadError(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true); setActionError(undefined);
    try {
      const path = editingName ? `/plugins/mcp/api/servers/${encodeURIComponent(editingName)}` : '/plugins/mcp/api/servers';
      await apiJson(path, { method: editingName ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(serverPayload(draft)) });
      setDraft(undefined); setEditingName(undefined); await load();
    } catch { setActionError(strings.saveError); }
    finally { setSaving(false); }
  };
  const reconnect = async (server: McpServer) => {
    await apiJson('/plugins/mcp/api/reconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: server.scope, name: server.name }) });
    await load();
  };
  const removeServer = async () => {
    if (!remove) return;
    await apiJson(`/plugins/mcp/api/servers/${encodeURIComponent(remove.name)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: remove.scope }) });
    setRemove(undefined); await load();
  };
  const openCreate = (scope: McpScope) => { setEditingName(undefined); setActionError(undefined); setDraft(emptyDraft(scope)); };
  const openEdit = (server: McpServer) => { setEditingName(server.name); setActionError(undefined); setDraft(serverDraft(server)); };
  const groups = useMemo(() => ([
    { scope: 'personal' as const, title: strings.personalTitle, description: strings.personalDescription, servers: data?.personal ?? [], empty: strings.emptyPersonal },
    ...(data?.canManageInstance ? [{ scope: 'instance' as const, title: strings.instanceTitle, description: strings.instanceDescription, servers: data.instance, empty: strings.emptyInstance }] : []),
  ]), [data, strings]);

  return (
    <>
      {surface === 'page' ? <PluginPageHeader title={strings.title} description={strings.description} icon={Blocks} action={<Button onClick={() => openCreate('personal')}><Plus size={14} />{strings.addServer}</Button>} /> : null}
      <SettingsDocument>
        {loading ? <LoadingState variant="cards" /> : loadError ? <ErrorState message={strings.loadError} onRetry={load} /> : groups.map((group) => (
          <SettingsGroup key={group.scope} title={group.title} description={group.description} actions={surface === 'deck' ? <Button size="sm" onClick={() => openCreate(group.scope)}><Plus size={13} />{strings.addServer}</Button> : undefined}>
            {group.servers.length === 0 ? <EmptyState title={group.empty} icon={Server} /> : <div className="grid gap-3">{group.servers.map((server) => (
              <ServerCard key={server.name} server={server} strings={strings} onEdit={() => openEdit(server)} onRemove={() => setRemove(server)} onReconnect={() => void reconnect(server)} onTools={() => setTools(server)} />
            ))}</div>}
          </SettingsGroup>
        ))}
      </SettingsDocument>
      {draft ? <ServerForm draft={draft} editing={Boolean(editingName)} strings={strings} saving={saving} error={actionError} onChange={setDraft} onSave={() => void save()} onClose={() => { setDraft(undefined); setEditingName(undefined); setActionError(undefined); }} canManageInstance={data?.canManageInstance === true} /> : null}
      <ConfirmDialog open={Boolean(remove)} title={remove ? strings.removeConfirm.replace('{name}', remove.name) : ''} confirmLabel={strings.removeServer} onClose={() => setRemove(undefined)} onConfirm={() => void removeServer()} />
      <ManageSelectionModal
        open={Boolean(tools)}
        title={tools ? `${strings.tools}: ${tools.name}` : strings.tools}
        subtitle={tools?.tools.length ? undefined : strings.noTools}
        onClose={() => setTools(undefined)}
        items={(tools?.tools ?? []).map((tool) => ({ id: tool.name, label: tool.title || tool.name, group: '', disabled: true, disabledHint: tool.description }))}
        selected={new Set((tools?.tools ?? []).map((tool) => tool.name))}
        onSave={() => setTools(undefined)}
        countLabel={(n: number) => strings.toolsCount.replace('{n}', String(n))}
      />
    </>
  );
}
