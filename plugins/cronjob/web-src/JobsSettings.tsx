import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, ChevronDown, ChevronRight, Clock, Hash, MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { runtime, type BrainModelOption, type CronJob, type DiscordChannelOption, type ManageSelectionItem } from './runtime';

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

/** One job: a collapsible row — status dot, name, schedule/destination badges and last run in the
 *  header; editable fields when expanded. The row edits and persists ITSELF (one PUT of this job), so a
 *  page that has not seen a job someone else just added can never write it away.
 *
 *  `job` is the server's copy and stays the source of truth for the scheduler-owned fields (last run,
 *  last result); `draft` holds what the user is typing. When the server's copy changes and the row has no
 *  unsaved edit, the draft adopts it — otherwise a job the brain's cron tools changed behind this page's
 *  back would be shown stale and overwritten by the row's next save. */
function CronJobRow({ job, persisted, channels, models, onRemoved }: {
  job: CronJob;
  persisted: boolean;
  channels: DiscordChannelOption[];
  models: BrainModelOption[];
  onRemoved: (id: string) => void;
}) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('cronjob');
  const { toast } = hooks.useToast();
  const save = hooks.useSaveCronJob();
  const del = hooks.useDeleteCronJob();
  const [draft, setDraft] = useState<CronJob>(job);
  const [open, setOpen] = useState(!persisted); // a row the user just added opens straight into its fields
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
  }, [serverCopy]); // serverCopy is the JSON identity of `job` — the intended dependency

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
  const dest = draft.notifyChannelId ? channels.find((ch) => ch.id === draft.notifyChannelId)?.name ?? draft.notifyChannelId : null;

  return (
    <div className="@container rounded-lg border border-border bg-elevated/40">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={15} className="shrink-0 text-text-muted" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-text-muted" aria-hidden />}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-success' : 'bg-text-muted/50'}`}
            title={enabled ? s.enabled : s.paused}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-text">{draft.name || s.jobNew}</span>
          {/* The badges are shrink-0 and would crowd the name off a narrow (mobile) row — the
              destination badge and last-run hide on mobile; only the compact schedule stays. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {lastRunMs != null ? (
              <span className="hidden text-tiny text-text-muted @sm:inline" title={new Date(lastRunMs).toLocaleString()}>
                {s.lastRun.replace('{t}', utils.compactElapsed(Date.now() - lastRunMs))}
              </span>
            ) : null}
            <C.Badge tone={validSchedule ? 'default' : 'danger'}>
              {draft.runAt ? <CalendarClock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden /> : <Clock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />}
              {draft.schedule}
            </C.Badge>
            <span className="hidden @sm:inline-flex">
              <C.Badge>
                <Hash size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />
                {dest ?? s.channelDefault}
              </C.Badge>
            </span>
          </span>
        </button>
        {/* In the header, not in the expanded body: a save that fails while the row is collapsed still has
            to show itself — and still has to offer Retry. */}
        <C.AutoSaveStatus status={autosave.status} onRetry={autosave.retry} />
        <C.Button variant="ghost" icon={Trash2} aria-label={s.removeJob} onClick={() => setConfirming(true)} />
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
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
                <C.Toggle checked={enabled} onChange={(v: boolean) => patch({ enabled: v })} label={`${draft.name || s.jobNew}: ${s.enabled}`} />
                {enabled ? s.enabled : s.paused}
              </span>
            </C.Field>
            {/* Positive toggle over the stored `plain` flag: checked = header shown (plain unset). */}
            <C.Field label={s.header} hint={s.helpHeader}>
              <span className="flex h-9 items-center text-sm text-text-muted">
                <C.Toggle checked={draft.plain !== true} onChange={(v: boolean) => patch({ plain: v ? undefined : true })} label={`${draft.name || s.jobNew}: ${s.header}`} />
              </span>
            </C.Field>
          </div>
          <C.Field label={s.check} hint={s.helpCheck}>
            <textarea
              value={draft.check ?? ''}
              onChange={(e) => patch({ check: e.target.value || undefined })}
              rows={2}
              className={textareaClass}
              placeholder="test -n &quot;$(ls /new-bookings 2>/dev/null)&quot; &amp;&amp; cat /new-bookings/*"
            />
          </C.Field>
          <C.Field label={s.prompt} hint={s.helpPrompt}>
            <textarea value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={5} className={textareaClass} />
          </C.Field>
          <C.Field label={s.channel} hint={s.helpChannel}>
            <ChannelField
              value={draft.notifyChannelId ?? ''}
              onChange={(v) => patch({ notifyChannelId: v || undefined })}
              channels={channels}
            />
          </C.Field>
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
        </div>
      ) : null}

      <C.ConfirmDialog
        open={confirming}
        title={s.deleteTitle}
        description={s.deleteDesc.replace('{name}', draft.name || s.jobNew)}
        confirmLabel={s.removeJob}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

/** Cron jobs manager (the cronjob plugin's settings-deck section). The list is the SERVER's — a job
 *  the scheduler or the brain's CronAdd tool creates shows up on the next refetch — and each row
 *  persists itself. A row added here lives locally only until the server has it; from then on the
 *  server's copy is the row. */
export function JobsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('cronjob');
  const { t } = hooks.useTranslation();
  const { data, isLoading, isError, refetch } = hooks.useCronJobs();
  const channels = hooks.useDiscordChannels();
  const models = hooks.useBrainModels();
  const [drafts, setDrafts] = useState<CronJob[]>([]);

  // A draft the server has taken is the server's now. Keeping it would resurrect the job as an unsaved
  // row the moment anything else deletes it — and one keystroke there would write it straight back.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.map((j) => j.id));
    setDrafts((cur) => (cur.some((j) => ids.has(j.id)) ? cur.filter((j) => !ids.has(j.id)) : cur));
  }, [data]);

  const body = () => {
    if (isError) return <C.ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
    if (isLoading || !data) return <C.LoadingState />;

    const saved = new Set(data.map((j) => j.id));
    const rows = [...data, ...drafts.filter((j) => !saved.has(j.id))];

    const addJob = () => {
      // Same id shape the plugin's own CronAdd tool generates.
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setDrafts((cur) => [...cur, { id, name: '', schedule: 'every 1h', prompt: '', enabled: false, createdAt: new Date().toISOString() }]);
    };
    const dropDraft = (id: string) => setDrafts((cur) => cur.filter((j) => j.id !== id));

    return (
      <div className="flex flex-col gap-3">
        {rows.length === 0 ? <p className="text-xs italic text-text-muted">{s.empty}</p> : null}
        {rows.map((job) => (
          <CronJobRow
            key={job.id}
            job={job}
            persisted={saved.has(job.id)}
            channels={channels.data ?? []}
            models={models.data ?? []}
            onRemoved={dropDraft}
          />
        ))}
        <div className="flex items-center justify-between gap-3">
          <button type="button" className="spatial-inline-action" onClick={addJob}><Plus size={14} aria-hidden />{s.addJob}</button>
        </div>
      </div>
    );
  };

  return (
    <C.PluginSection surface={surface} className="plugin-card" icon={Clock} title={s.title} description={s.sectionHint}>
      <div className="settings-group__panel">{body()}</div>
    </C.PluginSection>
  );
}
