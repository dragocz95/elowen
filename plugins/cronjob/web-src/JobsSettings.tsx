import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CalendarClock, Check, ChevronLeft, ChevronRight, Clock, Hash, MessageSquare, PauseCircle, Plus, Search, Timer, Trash2, X } from 'lucide-react';
import { runtime, type BrainModelOption, type CronJob, type DiscordChannelOption, type ManageSelectionItem } from './runtime';

/** One page of jobs, matching the register size the built-in workspaces page at. */
const PAGE_SIZE = 20;
type Filter = 'all' | 'active' | 'paused';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Single-select destination channel: the current pick as a compact chip ("—" = the guild's default
 *  channel) + a Manage modal grouping the guild's text channels and active threads. A saved id the
 *  guild no longer lists stays visible as a pinned, selected row so it is never silently lost. */
function ChannelField({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: DiscordChannelOption[] }) {
  const { components: C, hooks } = runtime();
  const { t } = hooks.useTranslation();
  const s = hooks.usePluginStrings('cronjob');
  const [open, setOpen] = useState(false);
  const selected = channels.find((ch) => ch.id === value);
  const icon = (type: DiscordChannelOption['type']) =>
    type === 'thread' ? <MessageSquare size={12} aria-hidden /> : <Hash size={12} aria-hidden />;
  const toItem = (ch: DiscordChannelOption): ManageSelectionItem => ({
    id: ch.id,
    label: ch.name,
    group: ch.type,
    groupLabel: ch.type === 'thread' ? t.managePicker.groupThreads : t.managePicker.groupChannels,
    icon: icon(ch.type),
    badges: ch.parentName ? [{ text: `#${ch.parentName}` }] : undefined,
  });
  const items: ManageSelectionItem[] = [
    // Pinned rows: the guild-default destination, plus a saved id the guild no longer lists.
    { id: '', label: s.pillDefault, group: '' },
    ...(value && !selected ? [{ id: value, label: value, group: '', icon: <Hash size={12} aria-hidden /> }] : []),
    // Text channels first, then threads — one group each.
    ...channels.filter((ch) => ch.type !== 'thread').map(toItem),
    ...channels.filter((ch) => ch.type === 'thread').map(toItem),
  ];
  return (
    <>
      <C.SelectionSummary
        countText={value ? '' : '—'}
        samples={value ? [{ label: selected?.name ?? value, icon: icon(selected?.type ?? 'channel') }] : []}
        moreCount={0}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <C.ManageSelectionModal
        title={s.channel}
        subtitle={s.helpChannel}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        onSave={(next: Set<string>) => onChange([...next][0] ?? '')}
      />
    </>
  );
}

/** One job: a table row, plus its editor in the workspace's detail drawer while the row is the selected
 *  one. The component stays mounted whether or not the drawer is open — the drawer portals out of this
 *  subtree — so a save that fails after the user closed the editor still shows itself, and still offers
 *  Retry, on the row it belongs to. Unmounting it on close would have thrown the unsaved draft away.
 *
 *  The row edits and persists ITSELF (one PUT of this job), so a page that has not seen a job someone
 *  else just added can never write it away.
 *
 *  `job` is the server's copy and stays the source of truth for the scheduler-owned fields (last run,
 *  last result); `draft` holds what the user is typing. When the server's copy changes and the row has no
 *  unsaved edit, the draft adopts it — otherwise a job the brain's cron tools changed behind this page's
 *  back would be shown stale and overwritten by the row's next save. */
function CronJobRow({ job, persisted, ownerLabel, adminFields, channels, models, selected, onSelect, onClose, onRemoved }: {
  job: CronJob;
  persisted: boolean;
  /** Who owns the job, for the admin's owner column; null hides the column (everyone else sees only their own). */
  ownerLabel: string | null;
  /** Whether this caller may set the fields only an INSTANCE job has: the shell guard (it runs a command
   *  on the host) and the destination channel (it belongs to the operator). The server refuses both on an
   *  owned job, so offering them to somebody whose save would be rejected is worse than not showing them. */
  adminFields: boolean;
  channels: DiscordChannelOption[];
  models: BrainModelOption[];
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('cronjob');
  const { t } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const save = hooks.useSaveCronJob();
  const del = hooks.useDeleteCronJob();
  const [draft, setDraft] = useState<CronJob>(job);
  const [confirming, setConfirming] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** Edits this row has not persisted yet. Only a clean row adopts a server change. */
  const dirty = useRef(false);
  /** Deleting a row unmounts it, and the auto-save flushes a pending edit on unmount — which would
   *  recreate the job we just deleted. Once it is gone, its save is a no-op; a DELETE that FAILS clears
   *  this again, or the row would sit there swallowing every further edit while reporting "saved". */
  const deleted = useRef(false);
  /** The save currently on the wire, and whether this row ever reached the server at all. A delete has to
   *  wait for the former (or the PUT lands after the DELETE and the job comes back) and only needs to send
   *  a DELETE when the latter is true. */
  const inFlight = useRef<Promise<unknown> | null>(null);
  const everSaved = useRef(persisted);

  /** A job the daemon's PUT validation would accept — auto-save holds off until the row qualifies, so a
   *  freshly added (still empty) job never fires a 400 toast mid-typing. */
  const isSavable = (j: CronJob): boolean =>
    j.name.trim() !== '' && j.prompt.trim() !== '' && (j.runAt ? true : utils.isValidSchedule(j.schedule));

  const autosave = hooks.useAutoSaveStatus([draft], async () => {
    if (deleted.current) return;
    const sent = draftRef.current;
    everSaved.current = true;
    const request = save.mutateAsync(sent);
    inFlight.current = request;
    try {
      await request;
      if (draftRef.current === sent) dirty.current = false; // still clean only if nothing was typed meanwhile
    } catch (error) {
      toast(s.saveError, 'error');
      throw error;
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }, { savable: isSavable(draft), delay: 900 });

  // Adopt the server's copy whenever it changes under a row with nothing unsaved in it.
  const serverCopy = JSON.stringify(job);
  useEffect(() => {
    if (dirty.current || deleted.current) return;
    setDraft(job);
    // serverCopy is the JSON identity of `job` — the intended dependency. Depending on `job` itself
    // would re-run on every render that hands over a new object with the same contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverCopy]);

  const patch = (p: Partial<CronJob>) => {
    dirty.current = true;
    setDraft((cur) => ({ ...cur, ...p }));
  };

  const remove = async () => {
    deleted.current = true;
    setConfirming(false);
    onRemoved(job.id);
    await inFlight.current?.catch(() => {}); // a DELETE must not overtake the save it would undo
    if (!everSaved.current) return;          // a row that never reached the server has nothing to delete
    try { await del.mutateAsync(job.id); }
    catch {
      deleted.current = false; // the job is still there — let the row keep saving
      toast(s.deleteError, 'error');
    }
  };

  const enabled = draft.enabled !== false;
  const validSchedule = draft.runAt ? true : utils.isValidSchedule(draft.schedule);
  const lastRunMs = utils.parseTs(job.lastRun);
  const destChannel = draft.notifyChannelId ? channels.find((ch) => ch.id === draft.notifyChannelId) : undefined;
  // An OWNED job has no channel destination at all — it reports in its owner's own conversation and no
  // channel may be set on it, so naming the notification channel here would describe a delivery that
  // never happens. Only an instance job falls back to "default channel".
  const dest = draft.notifyChannelId ? destChannel?.name ?? draft.notifyChannelId
    : job.ownerUserId != null ? s.channelOwnerChat : null;
  const name = draft.name || s.jobNew;

  return (
    <>
      <C.DataTableRow interactive selected={selected} aria-selected={selected} className="group">
        <C.DataTableCell className="flex items-center justify-center">
          <span
            className={`h-2 w-2 rounded-full ${enabled ? 'bg-success' : 'bg-text-muted/50'}`}
            title={enabled ? s.enabled : s.paused}
            aria-hidden
          />
        </C.DataTableCell>
        <C.DataTableCell>
          <button type="button" onClick={onSelect} className="flex w-full min-w-0 items-center gap-2 text-left">
            <span className="truncate text-sm text-text">{name}</span>
            {!enabled ? <C.Badge tone="muted">{s.paused}</C.Badge> : null}
          </button>
        </C.DataTableCell>
        <C.DataTableCell priority="wide" className="whitespace-nowrap">
          <C.Badge tone={validSchedule ? 'default' : 'danger'}>
            {draft.runAt ? <CalendarClock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden /> : <Clock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />}
            {draft.schedule}
          </C.Badge>
        </C.DataTableCell>
        {ownerLabel !== null ? (
          <C.DataTableCell priority="wide" title={ownerLabel} className="truncate text-xs text-text-muted">{ownerLabel}</C.DataTableCell>
        ) : null}
        {/* Destination: one line that truncates, full name on hover. A channel or thread title can be far
            longer than the column, and wrapping it pushed every other row out of alignment. Shown only to
            an admin: an owned job always reports in its owner's own conversation and they cannot change
            that, so the column would repeat one value down the whole page — and "default channel" would
            name a channel the job never writes to. */}
        {adminFields ? (
          <C.DataTableCell priority="wide" title={dest ?? s.channelDefault} className="truncate text-xs text-text-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">
                {destChannel?.type === 'thread' ? <MessageSquare size={12} aria-hidden /> : <Hash size={12} aria-hidden />}
              </span>
              <span className={`truncate ${dest ? '' : 'italic text-text-muted/65'}`}>{dest ?? s.channelDefault}</span>
            </span>
          </C.DataTableCell>
        ) : null}
        <C.DataTableCell priority="wide" title={lastRunMs != null ? new Date(lastRunMs).toLocaleString() : undefined} className="whitespace-nowrap text-xs text-text-muted">
          <span className="flex items-center gap-1.5">
            <Timer size={12} aria-hidden />
            <span className={lastRunMs == null ? 'text-text-muted/60' : undefined}>
              {lastRunMs != null ? utils.compactElapsed(Date.now() - lastRunMs) : '—'}
            </span>
          </span>
        </C.DataTableCell>
        <C.DataTableCell className="flex items-center justify-end gap-1.5">
          {/* On the row, not only in the drawer: a save that fails after the user closed the editor still
              has to show itself — and still has to offer Retry. */}
          <C.AutoSaveStatus status={autosave.status} onRetry={autosave.retry} />
          <ChevronRight size={15} aria-hidden className="shrink-0 text-text-muted/50 transition-colors group-hover:text-text" />
        </C.DataTableCell>
      </C.DataTableRow>

      {selected ? (
        <C.WorkspaceDetailRail label={name} closeLabel={t.common.close} onClose={onClose}>
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <C.Field label={s.name}>
                <C.Input value={draft.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ name: e.target.value })} placeholder="morning-digest" />
              </C.Field>
              <C.Field label={s.schedule} hint={s.helpSchedule}>
                <div className="relative">
                  <C.Input value={draft.schedule} onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ schedule: e.target.value })} className="pr-8 font-mono" placeholder="daily 06:00" />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2" title={validSchedule ? s.scheduleValid : s.scheduleInvalid}>
                    {validSchedule
                      ? <Check size={14} className="text-success" aria-label={s.scheduleValid} />
                      : <X size={14} className="text-danger" aria-label={s.scheduleInvalid} />}
                  </span>
                </div>
              </C.Field>
              <C.Field label={s.hours} hint={s.helpHours}>
                <C.Input value={draft.hours ?? ''} onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ hours: e.target.value || undefined })} className="font-mono" placeholder="5-21" />
              </C.Field>
              <C.Field label={s.enabled}>
                <span className="flex h-9 items-center gap-2 text-sm text-text-muted">
                  <C.Toggle checked={enabled} onChange={(v: boolean) => patch({ enabled: v })} label={`${name}: ${s.enabled}`} />
                  {enabled ? s.enabled : s.paused}
                </span>
              </C.Field>
              {/* Positive toggle over the stored `plain` flag: checked = header shown (plain unset). */}
              <C.Field label={s.header} hint={s.helpHeader}>
                <span className="flex h-9 items-center text-sm text-text-muted">
                  <C.Toggle checked={draft.plain !== true} onChange={(v: boolean) => patch({ plain: v ? undefined : true })} label={`${name}: ${s.header}`} />
                </span>
              </C.Field>
            </div>
            {adminFields ? (
              <C.Field label={s.check} hint={s.helpCheck}>
                <textarea
                  value={draft.check ?? ''}
                  onChange={(e) => patch({ check: e.target.value || undefined })}
                  rows={2}
                  className={textareaClass}
                  placeholder="test -n &quot;$(ls /new-bookings 2>/dev/null)&quot; &amp;&amp; cat /new-bookings/*"
                />
              </C.Field>
            ) : null}
            <C.Field label={s.prompt} hint={s.helpPrompt}>
              <textarea value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={8} className={textareaClass} />
            </C.Field>
            {adminFields ? (
              <C.Field label={s.channel} hint={s.helpChannel}>
                <ChannelField
                  value={draft.notifyChannelId ?? ''}
                  onChange={(v) => patch({ notifyChannelId: v || undefined })}
                  channels={channels}
                />
              </C.Field>
            ) : null}
            <C.Field label={s.model} hint={s.helpModel}>
              <C.BrainModelField
                value={draft.model ? `${draft.model.provider}/${draft.model.model}` : ''}
                onChange={(v: string) => {
                  const slash = v.indexOf('/');
                  patch({ model: slash > 0 ? { provider: v.slice(0, slash), model: v.slice(slash + 1) } : undefined });
                }}
                models={models}
                title={s.model}
                subtitle={s.helpModel}
                defaultLabel={s.modelDefault}
                keyOf={(m: BrainModelOption) => `${m.provider}/${m.model}`}
              />
            </C.Field>
            {job.lastResult ? (
              <C.Field label={s.lastResult}>
                <p className="whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-muted">{job.lastResult}</p>
              </C.Field>
            ) : null}
            <div className="flex justify-end border-t border-border pt-3">
              <C.Button variant="ghost-danger" icon={Trash2} onClick={() => setConfirming(true)}>{s.removeJob}</C.Button>
            </div>
          </div>
        </C.WorkspaceDetailRail>
      ) : null}

      <C.ConfirmDialog
        open={confirming}
        title={s.deleteTitle}
        description={s.deleteDesc.replace('{name}', name)}
        confirmLabel={s.removeJob}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

/** Cron jobs manager (the cronjob plugin's own page). The list is the SERVER's — a job the scheduler or
 *  the brain's CronAdd tool creates shows up on the next refetch — and each row persists itself. A row
 *  added here lives locally only until the server has it; from then on the server's copy is the row. */
export function JobsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('cronjob');
  const { t } = hooks.useTranslation();
  const { data, isLoading, isError, refetch } = hooks.useCronJobs();
  const me = hooks.useMe();
  const myId = me.data?.user?.id ?? null;
  const isAdmin = me.data?.user?.is_admin === true;
  const channels = hooks.useDiscordChannels();
  const models = hooks.useBrainModels();
  const [drafts, setDrafts] = useState<CronJob[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  // Only an admin sees more than one owner's jobs, so only he is offered the scope filter.
  const [scope, setScope] = useState<'all' | 'mine' | 'instance'>('all');
  const [page, setPage] = useState(0);

  // A draft the server has taken is the server's now. Keeping it would resurrect the job as an unsaved
  // row the moment anything else deletes it — and one keystroke there would write it straight back.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.map((j) => j.id));
    setDrafts((cur) => (cur.some((j) => ids.has(j.id)) ? cur.filter((j) => !ids.has(j.id)) : cur));
  }, [data]);

  const saved = useMemo(() => new Set((data ?? []).map((j) => j.id)), [data]);
  const rows = useMemo(() => [...(data ?? []), ...drafts.filter((j) => !saved.has(j.id))], [data, drafts, saved]);
  const active = rows.filter((j) => j.enabled !== false).length;
  const lastRun = rows.reduce<number | null>((newest, j) => {
    const ms = utils.parseTs(j.lastRun);
    return ms != null && (newest == null || ms > newest) ? ms : newest;
  }, null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((j) => {
      if (filter === 'active' && j.enabled === false) return false;
      if (filter === 'paused' && j.enabled !== false) return false;
      if (scope === 'mine' && !(j.ownerUserId != null && j.ownerUserId === myId)) return false;
      if (scope === 'instance' && j.ownerUserId != null) return false;
      if (needle === '') return true;
      return j.name.toLowerCase().includes(needle) || j.schedule.toLowerCase().includes(needle) || j.prompt.toLowerCase().includes(needle);
    });
  }, [rows, query, filter, scope, myId]);
  // A narrowed list can be shorter than the page the user is on; landing on an empty page reads as
  // "nothing matches" when the matches are simply on page 1.
  useEffect(() => { setPage(0); }, [query, filter, scope]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(() => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE), [filtered, clampedPage]);

  const addJob = () => {
    // Same id shape the plugin's own CronAdd tool generates.
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setDrafts((cur) => [...cur, { id, name: '', schedule: 'every 1h', prompt: '', enabled: false, createdAt: new Date().toISOString() }]);
    setSelectedId(id); // a job the user just added opens straight into its fields
  };
  const dropDraft = (id: string) => {
    setDrafts((cur) => cur.filter((j) => j.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const addButton = <C.Button variant="accent" icon={Plus} onClick={addJob}>{s.addJob}</C.Button>;

  const table = (
    <div className="flex min-w-0 flex-col gap-3">
      <C.DataTable
        ariaLabel={s.title}
        columns={isAdmin ? '2rem minmax(0,1fr) 9.5rem 7rem minmax(0,12rem) 7rem 5.5rem' : '2rem minmax(0,1fr) 9.5rem 7rem 5.5rem'}
        compactColumns="2rem minmax(0,1fr) 5.5rem"
      >
        <C.DataTableRow header>
          <C.DataTableCell header><span className="sr-only">{s.enabled}</span></C.DataTableCell>
          <C.DataTableCell header>{s.name}</C.DataTableCell>
          <C.DataTableCell header priority="wide">{s.schedule}</C.DataTableCell>
          {isAdmin ? <C.DataTableCell header priority="wide">{s.ownerColumn}</C.DataTableCell> : null}
          {isAdmin ? <C.DataTableCell header priority="wide">{s.channel}</C.DataTableCell> : null}
          <C.DataTableCell header priority="wide" className="whitespace-nowrap">{s.colLastRun}</C.DataTableCell>
          <C.DataTableCell header role="presentation" aria-hidden>{null}</C.DataTableCell>
        </C.DataTableRow>
        {pageItems.map((job) => (
          <CronJobRow
            key={job.id}
            job={job}
            persisted={saved.has(job.id)}
            ownerLabel={isAdmin ? (job.ownerUserId == null ? s.ownerInstance : job.ownerUserId === myId ? s.ownerMine : `#${job.ownerUserId}`) : null}
            adminFields={isAdmin}
            channels={channels.data ?? []}
            models={models.data ?? []}
            selected={selectedId === job.id}
            onSelect={() => setSelectedId(job.id)}
            onClose={() => setSelectedId(null)}
            onRemoved={dropDraft}
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

  const surfaceDocument = (
    <C.ControlSurfaceDocument>
      {isError ? <C.ControlSurfaceState tone="danger"><C.ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} /></C.ControlSurfaceState>
        : isLoading || !data ? <C.ControlSurfaceState><C.LoadingState variant="cards" /></C.ControlSurfaceState>
        : (
          <div className="flex min-w-0 flex-col gap-4">
            <C.ControlSurfaceToolbar className="flex-col items-stretch">
              <div className="flex min-w-0 flex-wrap items-center gap-2 py-3">
                <div className="relative min-w-[15rem] flex-1">
                  <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <C.Input value={query} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} placeholder={s.searchPlaceholder} className="pl-9" />
                </div>
                <C.Segmented
                  value={filter}
                  onChange={(v: string) => setFilter(v as Filter)}
                  options={[{ value: 'all', label: s.filterAll }, { value: 'active', label: s.filterActive }, { value: 'paused', label: s.filterPaused }]}
                  aria-label={s.enabled}
                  nowrap
                />
                {isAdmin ? (
                  <C.Segmented
                    value={scope}
                    onChange={(v: string) => setScope(v as 'all' | 'mine' | 'instance')}
                    options={[{ value: 'all', label: s.filterAll }, { value: 'mine', label: s.filterMine }, { value: 'instance', label: s.filterInstance }]}
                    aria-label={s.ownerColumn}
                    nowrap
                  />
                ) : null}
                {surface === 'deck' ? addButton : null}
              </div>
            </C.ControlSurfaceToolbar>

            <C.ControlSurfaceRegister className="flex flex-col gap-4">
              {rows.length === 0
                ? <C.EmptyState title={s.empty} icon={Clock} action={addButton} />
                : filtered.length === 0
                  ? <C.EmptyState title={s.emptySearch} icon={Search} />
                  : table}
            </C.ControlSurfaceRegister>
          </div>
        )}
    </C.ControlSurfaceDocument>
  );

  // In the Settings deck the surrounding panel supplies the page frame; on its own page the section
  // wears the same spatial workspace every built-in page wears.
  if (surface === 'deck') return surfaceDocument;
  return (
    <C.SpatialWorkspaceLayout
      hero={{
        eyebrow: s.workspaceEyebrow,
        title: s.title,
        count: rows.length,
        description: s.sectionHint,
        mascotState: isLoading ? 'saving' : isError ? 'error' : 'idle',
        status: !isLoading && !isError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={s.metricActive} value={active} icon={Activity} />
          <C.WorkspaceMetric label={s.metricPaused} value={rows.length - active} icon={PauseCircle} />
          <C.WorkspaceMetric label={s.colLastRun} value={lastRun != null ? utils.compactElapsed(Date.now() - lastRun) : '—'} icon={Timer} />
        </>,
      }}
    >
      {surfaceDocument}
    </C.SpatialWorkspaceLayout>
  );
}
