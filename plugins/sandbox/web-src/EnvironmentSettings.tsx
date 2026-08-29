import { useEffect, useState } from 'react';
import { Activity, Boxes, HardDrive, ShieldCheck, ShieldX } from 'lucide-react';
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
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const facts: [string, string][] = [
    [s.homeSize, `${formatBytes(state.home.bytes)}${state.home.truncated ? '+' : ''}`],
    [s.homeGeneration, String(state.home.generation)],
    [s.processes, String(state.home.activeProcesses)],
  ];

  // A dialog is a form, not a page: settings CARDS inside one repeat the frame it already draws and
  // stack their own headings under its title. So this is the shape the other dialogs use — an identity
  // block, then plain fields, with the actions in the footer.
  const document = (
    <>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background">
          {/* `text-primary`, not `text-accent`: in this design `accent` is the INTERACTIVE SURFACE — a
              10% wash of the foreground — so as an ink it renders the glyph nearly invisible. The icon
              identifies the sandbox mode rather than reporting its health (the badge beside it carries
              success/danger), so the brand colour is what it wants. */}
          <ModeIcon size={20} className={state.mode === 'unavailable' ? 'text-destructive' : 'text-primary'} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{modeLabel}</div>
          <div className="truncate font-mono text-xs text-muted-foreground" title={state.home.path}>{state.home.path}</div>
        </div>
        <C.Badge tone={state.probe.available ? 'success' : 'danger'}>{state.probe.available ? s.probeReady : s.probeFailed}</C.Badge>
      </div>

      {/* Only a FAILED probe has something to say. The confined-mode caveat is normal operation, so it
          belongs on the plugin's own page, not in front of someone editing a Git author. */}
      {state.probe.reason ? <p className="text-xs leading-relaxed text-muted-foreground">{state.probe.reason}</p> : null}

      <C.Field label={s.home}>
        <div className="grid grid-cols-3 gap-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0 rounded-md border border-border bg-background px-3 py-2">
              <div className="truncate font-mono text-sm text-foreground" title={value}>{value}</div>
              <div className="truncate text-[11px] text-muted-foreground" title={label}>{label}</div>
            </div>
          ))}
        </div>
      </C.Field>

      <C.Field label={s.authorName}>
        <C.Input value={author.name} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAuthor({ ...author, name: event.target.value })} />
      </C.Field>
      <C.Field label={s.authorEmail}>
        <C.Input type="email" value={author.email} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setAuthor({ ...author, email: event.target.value })} />
      </C.Field>
    </>
  );

  // In the user drawer this is ONE row among the account's other summaries, not a page: it reads as the
  // same kind of preview the tool and project pickers use, and the settings themselves open on top of it.
  return <>
    {state.migrationCollision ? <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">{s.migrationCollision}</div> : null}
    <C.SelectionSummary
      countText={modeLabel}
      samples={[
        { label: `${s.homeSize}: ${formatBytes(state.home.bytes)}${state.home.truncated ? '+' : ''}`, icon: <HardDrive size={13} aria-hidden /> },
        { label: `${s.processes}: ${state.home.activeProcesses}`, icon: <Activity size={13} aria-hidden /> },
        { label: state.probe.available ? s.probeReady : s.probeFailed, icon: <ModeIcon size={13} aria-hidden /> },
      ]}
      onManage={() => setSettingsOpen(true)}
      manageLabel={s.manageEnvironment}
    />
    {settingsOpen ? (
      <C.Modal title={s.environmentTitle} description={s.environmentHint} icon={Boxes} size="md" onClose={() => setSettingsOpen(false)}>
        <C.ModalBody>{document}</C.ModalBody>
        {/* Destructive left, primary right — the footer's own split, so neither needs a card to sit in. */}
        <C.ModalFooter status={(
          <C.Button
            variant="ghost-danger"
            disabled={previewReset.isPending || state.home.activeProcesses > 0}
            title={state.home.activeProcesses > 0 ? s.error_home_in_use : undefined}
            onClick={() => previewReset.mutate({})}
          >
            {s.resetHome}
          </C.Button>
        )}>
          <C.Button
            variant="accent"
            disabled={saveAuthor.isPending || !author.name.trim() || !author.email.trim()}
            onClick={() => saveAuthor.mutate(author)}
          >
            {s.saveAuthor}
          </C.Button>
        </C.ModalFooter>
      </C.Modal>
    ) : null}
    {resetPreview ? (
      <C.Modal title={s.resetTitle} size="sm" onClose={() => setResetPreview(null)}>
        <C.ModalBody>
          <p className="text-sm leading-relaxed text-destructive">{s.resetWarning}</p>
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-foreground">
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
