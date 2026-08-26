import { useEffect, useState } from 'react';
import { Network, ShieldCheck, ShieldX } from 'lucide-react';
import { jsonBody, localizedError, runtime, type EnvironmentState, type User } from './runtime';
type ResetPreview = { generation: number; bytes: number; entries: number; activeProcesses: number; author: { name: string; email: string }; phrase: string; previewHash: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function EnvironmentSettings({ user }: { user: User; surface: 'user' }) {
  const { components: C, hooks, api } = runtime();
  const s = hooks.usePluginStrings('sandbox');
  const { toast } = hooks.useToast();
  const qc = hooks.useQueryClient();
  const queryKey = ['plugin', 'sandbox', 'environment', user.id];
  const endpoint = (path = '') => `/plugins/sandbox/api/environment${path}?userId=${encodeURIComponent(String(user.id))}`;
  const query = hooks.useQuery<EnvironmentState>({ queryKey, queryFn: () => api(endpoint()) });
  const [author, setAuthor] = useState({ name: '', email: '' });
  const [resetPreview, setResetPreview] = useState<ResetPreview | null>(null);
  const [phrase, setPhrase] = useState('');

  useEffect(() => {
    if (query.data) setAuthor(query.data.author);
  }, [query.data]);

  const invalidate = async () => { await qc.invalidateQueries({ queryKey }); };
  const saveAuthor = hooks.useMutation<{ author: { name: string; email: string } }, unknown, { name: string; email: string }>({
    mutationFn: (value: { name: string; email: string }) => api(endpoint('/author'), jsonBody(value)) as Promise<{ author: { name: string; email: string } }>,
    onSuccess: async () => { await invalidate(); toast(s.authorSaved); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });
  const previewReset = hooks.useMutation<ResetPreview, unknown, Record<string, never>>({
    mutationFn: () => api(endpoint('/reset-preview'), jsonBody({})) as Promise<ResetPreview>,
    onSuccess: (data: ResetPreview) => { setResetPreview(data); setPhrase(''); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });
  const reset = hooks.useMutation<unknown, unknown, { previewHash: string; phrase: string }>({
    mutationFn: (value: { previewHash: string; phrase: string }) => api(endpoint('/reset'), jsonBody(value)),
    onSuccess: async () => { setResetPreview(null); setPhrase(''); await invalidate(); toast(s.homeReset); },
    onError: (error: unknown) => toast(localizedError(error, s), 'error'),
  });

  if (query.isError) return <C.ErrorState message={s.loadError} onRetry={() => query.refetch()} />;
  if (query.isLoading || !query.data) return <C.LoadingState variant="cards" />;
  const state = query.data;
  const modeLabel = state.mode === 'confined' ? s.modeConfined : state.mode === 'direct' ? s.modeDirect : s.modeUnavailable;
  const ModeIcon = state.mode === 'unavailable' ? ShieldX : ShieldCheck;

  const document = (
    <C.SettingsDocument>
      {state.migrationCollision ? <div role="alert" className="rounded-lg border border-danger/50 bg-danger/5 p-4 text-sm text-danger">{s.migrationCollision}</div> : null}
      <C.SettingsGroup title={s.mode} description={s.environmentHint}>
        <C.SettingsRow label={s.mode} hint={state.mode === 'confined' ? s.networkCaveat : undefined}>
          <C.Badge tone={state.mode === 'unavailable' ? 'danger' : state.mode === 'confined' ? 'success' : 'accent'}><ModeIcon size={12} className="mr-1" aria-hidden />{modeLabel}</C.Badge>
        </C.SettingsRow>
        <C.SettingsRow label={s.probe} hint={state.probe.reason ?? undefined}>
          <C.Badge tone={state.probe.available ? 'success' : 'danger'}>{state.probe.available ? s.probeReady : s.probeFailed}</C.Badge>
        </C.SettingsRow>
        {state.mode === 'confined' ? <C.SettingsRow label={s.networkCaveat}><Network size={18} className="text-text-muted" aria-hidden /></C.SettingsRow> : null}
      </C.SettingsGroup>

      <C.SettingsGroup title={s.home} description={state.home.path}>
        <C.SettingsRow label={s.homeSize}><span className="font-mono text-sm text-text">{formatBytes(state.home.bytes)}{state.home.truncated ? '+' : ''}</span></C.SettingsRow>
        <C.SettingsRow label={s.homeGeneration}><span className="font-mono text-sm text-text">{state.home.generation}</span></C.SettingsRow>
        <C.SettingsRow label={s.processes}><span className="font-mono text-sm text-text">{state.home.activeProcesses}</span></C.SettingsRow>
      </C.SettingsGroup>

      <C.SettingsGroup title={s.gitAuthor}>
        <C.SettingsRow label={s.authorName}><C.Input value={author.name} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAuthor({ ...author, name: event.target.value })} /></C.SettingsRow>
        <C.SettingsRow label={s.authorEmail}><C.Input type="email" value={author.email} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAuthor({ ...author, email: event.target.value })} /></C.SettingsRow>
        <div className="flex justify-end p-4 pt-0"><C.Button variant="accent" disabled={saveAuthor.isPending || !author.name.trim() || !author.email.trim()} onClick={() => saveAuthor.mutate(author)}>{s.saveAuthor}</C.Button></div>
      </C.SettingsGroup>

      <C.SettingsGroup title={s.resetHome} description={s.resetWarning}>
        <div className="flex justify-end p-4"><C.Button variant="danger" disabled={previewReset.isPending || state.home.activeProcesses > 0} onClick={() => previewReset.mutate({})}>{s.resetHome}</C.Button></div>
      </C.SettingsGroup>
    </C.SettingsDocument>
  );

  return <>
    {document}
    {resetPreview ? (
      <C.Modal title={s.resetTitle} size="sm" onClose={() => setResetPreview(null)}>
        <C.ModalBody>
          <p className="text-sm leading-relaxed text-danger">{s.resetWarning}</p>
          <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-xs text-text">
            <div>{s.homeSize}: {formatBytes(resetPreview.bytes)}</div>
            <div>{s.processes}: {resetPreview.activeProcesses}</div>
            <div>{s.gitAuthor}: {resetPreview.author.name || '—'} &lt;{resetPreview.author.email || '—'}&gt;</div>
          </div>
          <C.Field label={`${s.confirmationPhrase}: ${resetPreview.phrase}`}><C.Input autoFocus value={phrase} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPhrase(event.target.value)} /></C.Field>
        </C.ModalBody>
        <C.ModalFooter><C.Button variant="ghost" onClick={() => setResetPreview(null)}>{s.cancel}</C.Button><C.Button variant="danger" disabled={phrase !== resetPreview.phrase || reset.isPending || resetPreview.activeProcesses > 0} onClick={() => reset.mutate({ previewHash: resetPreview.previewHash, phrase })}>{s.reset}</C.Button></C.ModalFooter>
      </C.Modal>
    ) : null}
  </>;
}
