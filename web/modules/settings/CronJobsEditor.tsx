'use client';
import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Check, ChevronDown, ChevronRight, Clock, Hash, MessageSquare, Plus, Trash2, X } from 'lucide-react';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { compactElapsed, parseTs } from '../../lib/format';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Toggle } from '../../components/ui/Toggle';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { useTranslation } from '../../lib/i18n';
import { isValidSchedule } from '../../lib/cronSchedule';
import { useCronJobs, useDiscordChannels, useBrainModels } from '../../lib/queries';
import { useSaveCronJob, useDeleteCronJob } from '../../lib/mutations';
import type { BrainModelOption, CronJob, DiscordChannelOption } from '../../lib/types';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** A job the daemon's PUT validation would accept — auto-save holds off until the row qualifies, so a
 *  freshly added (still empty) job never fires a 400 toast mid-typing. */
const isSavable = (j: CronJob): boolean =>
  j.name.trim() !== '' && j.prompt.trim() !== '' && (j.runAt ? true : isValidSchedule(j.schedule));

/** Single-select destination channel: the current pick as a compact chip ("—" = the guild's default
 *  channel) + a Manage modal grouping the guild's text channels and active threads. A saved id the
 *  guild no longer lists stays visible as a pinned, selected row so it is never silently lost. */
function ChannelField({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: DiscordChannelOption[] }) {
  const { t } = useTranslation();
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
    { id: '', label: t.cron.pillDefault, group: '' },
    ...(value && !selected ? [{ id: value, label: value, group: '', icon: <Hash size={12} aria-hidden /> }] : []),
    // Text channels first, then threads — one group each.
    ...channels.filter((ch) => ch.type !== 'thread').map(toItem),
    ...channels.filter((ch) => ch.type === 'thread').map(toItem),
  ];
  return (
    <>
      <SelectionSummary
        countText={value ? '' : '—'}
        samples={value ? [{ label: selected?.name ?? value, icon: icon(selected?.type ?? 'channel') }] : []}
        moreCount={0}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
      />
      <ManageSelectionModal
        title={t.cron.channel}
        subtitle={t.help.cronChannel}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set([value])}
        single
        onSave={(next) => onChange([...next][0] ?? '')}
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
  const { t } = useTranslation();
  const { toast } = useToast();
  const save = useSaveCronJob();
  const del = useDeleteCronJob();
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

  const autosave = useAutoSaveStatus([draft], async () => {
    if (deleted.current) return;
    const sent = draftRef.current;
    everSaved.current = true;
    const request = save.mutateAsync(sent);
    inFlight.current = request;
    try {
      await request;
      if (draftRef.current === sent) dirty.current = false; // still clean only if nothing was typed meanwhile
    } catch (error) {
      toast(t.cron.saveError, 'error');
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
      toast(t.cron.deleteError, 'error');
    }
  };

  const enabled = draft.enabled !== false;
  const validSchedule = draft.runAt ? true : isValidSchedule(draft.schedule);
  const lastRunMs = parseTs(job.lastRun);
  const dest = draft.notifyChannelId ? channels.find((ch) => ch.id === draft.notifyChannelId)?.name ?? draft.notifyChannelId : null;

  return (
    <div className="@container rounded-lg border border-border bg-elevated/40">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={15} className="shrink-0 text-text-muted" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-text-muted" aria-hidden />}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-success' : 'bg-text-muted/50'}`}
            title={enabled ? t.cron.enabled : t.cron.paused}
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-text">{draft.name || t.cron.jobNew}</span>
          {/* The badges are shrink-0 and would crowd the name off a narrow (mobile) row — the
              destination badge and last-run hide on mobile; only the compact schedule stays. */}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {lastRunMs != null ? (
              <span className="hidden text-tiny text-text-muted @sm:inline" title={new Date(lastRunMs).toLocaleString()}>
                {t.cron.lastRun.replace('{t}', compactElapsed(Date.now() - lastRunMs))}
              </span>
            ) : null}
            <Badge tone={validSchedule ? 'default' : 'danger'}>
              {draft.runAt ? <CalendarClock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden /> : <Clock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />}
              {draft.schedule}
            </Badge>
            <span className="hidden @sm:inline-flex">
              <Badge>
                <Hash size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />
                {dest ?? t.cron.channelDefault}
              </Badge>
            </span>
          </span>
        </button>
        {/* In the header, not in the expanded body: a save that fails while the row is collapsed still has
            to show itself — and still has to offer Retry. */}
        <AutoSaveStatus status={autosave.status} onRetry={autosave.retry} />
        <Button variant="ghost" icon={Trash2} aria-label={t.cron.removeJob} onClick={() => setConfirming(true)} />
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-border p-3">
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
            <Field label={t.cron.name}>
              <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="morning-digest" />
            </Field>
            <Field label={t.cron.schedule} hint={t.help.cronSchedule}>
              <div className="relative">
                <Input value={draft.schedule} onChange={(e) => patch({ schedule: e.target.value })} className="pr-8 font-mono" placeholder="daily 06:00" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2" title={validSchedule ? t.cron.scheduleValid : t.cron.scheduleInvalid}>
                  {validSchedule
                    ? <Check size={14} className="text-success" aria-label={t.cron.scheduleValid} />
                    : <X size={14} className="text-danger" aria-label={t.cron.scheduleInvalid} />}
                </span>
              </div>
            </Field>
            <Field label={t.cron.hours} hint={t.help.cronHours}>
              <Input value={draft.hours ?? ''} onChange={(e) => patch({ hours: e.target.value || undefined })} className="font-mono" placeholder="5-21" />
            </Field>
            <Field label={t.cron.enabled}>
              <span className="flex h-9 items-center gap-2 text-sm text-text-muted">
                <Toggle checked={enabled} onChange={(v) => patch({ enabled: v })} label={`${draft.name || t.cron.jobNew}: ${t.cron.enabled}`} />
                {enabled ? t.cron.enabled : t.cron.paused}
              </span>
            </Field>
            {/* Positive toggle over the stored `plain` flag: checked = header shown (plain unset). */}
            <Field label={t.cron.header} hint={t.help.cronHeader}>
              <span className="flex h-9 items-center text-sm text-text-muted">
                <Toggle checked={draft.plain !== true} onChange={(v) => patch({ plain: v ? undefined : true })} label={`${draft.name || t.cron.jobNew}: ${t.cron.header}`} />
              </span>
            </Field>
          </div>
          <Field label={t.cron.check} hint={t.help.cronCheck}>
            <textarea
              value={draft.check ?? ''}
              onChange={(e) => patch({ check: e.target.value || undefined })}
              rows={2}
              className={textareaClass}
              placeholder="test -n &quot;$(ls /new-bookings 2>/dev/null)&quot; &amp;&amp; cat /new-bookings/*"
            />
          </Field>
          <Field label={t.cron.prompt} hint={t.help.cronPrompt}>
            <textarea value={draft.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={5} className={textareaClass} />
          </Field>
          <Field label={t.cron.channel} hint={t.help.cronChannel}>
            <ChannelField
              value={draft.notifyChannelId ?? ''}
              onChange={(v) => patch({ notifyChannelId: v || undefined })}
              channels={channels}
            />
          </Field>
          <Field label={t.cron.model} hint={t.help.cronModel}>
            <BrainModelField
              value={draft.model ? `${draft.model.provider}/${draft.model.model}` : ''}
              onChange={(v) => {
                const slash = v.indexOf('/');
                patch({ model: slash > 0 ? { provider: v.slice(0, slash), model: v.slice(slash + 1) } : undefined });
              }}
              models={models}
              title={t.cron.model}
              subtitle={t.help.cronModel}
              defaultLabel={t.cron.modelDefault}
              keyOf={(m) => `${m.provider}/${m.model}`}
            />
          </Field>
          {job.lastResult ? (
            <Field label={t.cron.lastResult}>
              <p className="whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-muted">{job.lastResult}</p>
            </Field>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title={t.cron.deleteTitle}
        description={t.cron.deleteDesc.replace('{name}', draft.name || t.cron.jobNew)}
        confirmLabel={t.cron.removeJob}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

/** Cron jobs manager (the cronjob plugin detail). The list is the SERVER's — a job the scheduler or the
 *  brain's CronAdd tool creates shows up on the next refetch — and each row persists itself. A row added
 *  here lives locally only until the server has it; from then on the server's copy is the row. */
export function CronJobsEditor() {
  const { t } = useTranslation();
  const { data, isLoading } = useCronJobs();
  const channels = useDiscordChannels();
  const models = useBrainModels();
  const [drafts, setDrafts] = useState<CronJob[]>([]);

  // A draft the server has taken is the server's now. Keeping it would resurrect the job as an unsaved
  // row the moment anything else deletes it — and one keystroke there would write it straight back.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.map((j) => j.id));
    setDrafts((cur) => (cur.some((j) => ids.has(j.id)) ? cur.filter((j) => !ids.has(j.id)) : cur));
  }, [data]);

  if (isLoading || !data) return <LoadingState />;

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
      {rows.length === 0 ? <p className="text-xs italic text-text-muted">{t.cron.empty}</p> : null}
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
        <button type="button" className="spatial-inline-action" onClick={addJob}><Plus size={14} aria-hidden />{t.cron.addJob}</button>
      </div>
    </div>
  );
}
