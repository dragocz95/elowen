'use client';
import { useEffect, useState } from 'react';
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
import { useCronJobs, useDiscordChannels, useBrainModels } from '../../lib/queries';
import { useSaveCronJobs } from '../../lib/mutations';
import type { CronJob, DiscordChannelOption } from '../../lib/types';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Whether a recurring schedule spec is valid — the live indicator next to the schedule field.
 *  Mirrors `parseSchedule` in plugins/cronjob/index.mjs (and the daemon's PUT validation). */
function isValidSchedule(spec: string): boolean {
  const s = spec.trim();
  const every = /^every\s+(\d+)\s*(m|h)$/i.exec(s);
  if (every) return Number(every[1]) >= 1;
  return /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s)
    || /^weekly\s+(sun|mon|tue|wed|thu|fri|sat)\s+([01]?\d|2[0-3]):([0-5]\d)$/i.test(s);
}

/** A job the daemon's PUT validation would accept — auto-save holds off until every row qualifies,
 *  so a freshly added (still empty) job never fires a 400 toast mid-typing. */
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

/** Cron jobs manager (the cronjob plugin detail): each job is a collapsible row — status dot, name,
 *  schedule/destination badges and last run in the header; editable fields when expanded. Edits
 *  auto-persist as one PUT of the whole list; the plugin's scheduler re-reads the file every tick,
 *  so changes apply live without a restart. */
export function CronJobsEditor() {
  const { t } = useTranslation();
  const { data, isLoading } = useCronJobs();
  const channels = useDiscordChannels();
  const models = useBrainModels();
  const save = useSaveCronJobs();
  const { toast } = useToast();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Seed ONCE from the server — the save mutation invalidates ['cron-jobs'], and re-seeding on that
  // refetch would clobber whatever the user typed while the auto-save was in flight.
  useEffect(() => { if (data && !seeded) { setJobs(data); setSeeded(true); } }, [data, seeded]);

  const autosave = useAutoSaveStatus([jobs], async () => {
    try { await save.mutateAsync(jobs); }
    catch (error) { toast(t.cron.saveError, 'error'); throw error; }
  }, { ready: seeded && jobs.every(isSavable), delay: 900 });

  if (isLoading || !seeded) return <LoadingState />;

  const patch = (id: string, p: Partial<CronJob>) => setJobs((cur) => cur.map((j) => (j.id === id ? { ...j, ...p } : j)));
  const toggleRow = (id: string) => setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const addJob = () => {
    // Same id shape the plugin's own cron_add tool generates.
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setExpanded((prev) => new Set(prev).add(id));
    setJobs((cur) => [...cur, { id, name: '', schedule: 'every 1h', prompt: '', enabled: false, createdAt: new Date().toISOString() }]);
  };
  const removeJob = (id: string) => setJobs((cur) => cur.filter((j) => j.id !== id));

  const channelName = (id?: string) => (id ? channels.data?.find((ch) => ch.id === id)?.name ?? id : null);
  const deleteTarget = jobs.find((j) => j.id === pendingDelete);

  return (
    <div className="flex flex-col gap-3">
      {jobs.length === 0 ? <p className="text-xs italic text-text-muted">{t.cron.empty}</p> : null}
      {jobs.map((job) => {
        const open = expanded.has(job.id);
        const enabled = job.enabled !== false;
        const validSchedule = job.runAt ? true : isValidSchedule(job.schedule);
        const lastRunMs = parseTs(job.lastRun);
        const dest = channelName(job.notifyChannelId);
        return (
          <div key={job.id} className="@container rounded-lg border border-border bg-elevated/40">
            <div className="flex items-center gap-2 p-3">
              <button type="button" onClick={() => toggleRow(job.id)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown size={15} className="shrink-0 text-text-muted" aria-hidden /> : <ChevronRight size={15} className="shrink-0 text-text-muted" aria-hidden />}
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${enabled ? 'bg-success' : 'bg-text-muted/50'}`}
                  title={enabled ? t.cron.enabled : t.cron.paused}
                  aria-hidden
                />
                <span className="truncate text-sm font-medium text-text">{job.name || t.cron.jobNew}</span>
                {/* The badges are shrink-0 and would crowd the name off a narrow (mobile) row — the
                    destination badge and last-run hide on mobile; only the compact schedule stays. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {lastRunMs != null ? (
                    <span className="hidden text-tiny text-text-muted @sm:inline" title={new Date(lastRunMs).toLocaleString()}>
                      {t.cron.lastRun.replace('{t}', compactElapsed(Date.now() - lastRunMs))}
                    </span>
                  ) : null}
                  <Badge tone={validSchedule ? 'default' : 'danger'}>
                    {job.runAt ? <CalendarClock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden /> : <Clock size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />}
                    {job.schedule}
                  </Badge>
                  <span className="hidden @sm:inline-flex">
                    <Badge>
                      <Hash size={10} className="mr-1 inline-block align-[-1px]" aria-hidden />
                      {dest ?? t.cron.channelDefault}
                    </Badge>
                  </span>
                </span>
              </button>
              <Button variant="ghost" icon={Trash2} aria-label={t.cron.removeJob} onClick={() => setPendingDelete(job.id)} />
            </div>
            {open ? (
              <div className="flex flex-col gap-3 border-t border-border p-3">
                <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                  <Field label={t.cron.name}>
                    <Input value={job.name} onChange={(e) => patch(job.id, { name: e.target.value })} placeholder="morning-digest" />
                  </Field>
                  <Field label={t.cron.schedule} hint={t.help.cronSchedule}>
                    <div className="relative">
                      <Input value={job.schedule} onChange={(e) => patch(job.id, { schedule: e.target.value })} className="pr-8 font-mono" placeholder="daily 06:00" />
                      <span className="absolute right-2.5 top-1/2 -translate-y-1/2" title={validSchedule ? t.cron.scheduleValid : t.cron.scheduleInvalid}>
                        {validSchedule
                          ? <Check size={14} className="text-success" aria-label={t.cron.scheduleValid} />
                          : <X size={14} className="text-danger" aria-label={t.cron.scheduleInvalid} />}
                      </span>
                    </div>
                  </Field>
                  <Field label={t.cron.hours} hint={t.help.cronHours}>
                    <Input value={job.hours ?? ''} onChange={(e) => patch(job.id, { hours: e.target.value || undefined })} className="font-mono" placeholder="5-21" />
                  </Field>
                  <Field label={t.cron.enabled}>
                    <span className="flex h-9 items-center gap-2 text-sm text-text-muted">
                      <Toggle checked={enabled} onChange={(v) => patch(job.id, { enabled: v })} label={`${job.name || t.cron.jobNew}: ${t.cron.enabled}`} />
                      {enabled ? t.cron.enabled : t.cron.paused}
                    </span>
                  </Field>
                  {/* Positive toggle over the stored `plain` flag: checked = header shown (plain unset). */}
                  <Field label={t.cron.header} hint={t.help.cronHeader}>
                    <span className="flex h-9 items-center text-sm text-text-muted">
                      <Toggle checked={job.plain !== true} onChange={(v) => patch(job.id, { plain: v ? undefined : true })} label={`${job.name || t.cron.jobNew}: ${t.cron.header}`} />
                    </span>
                  </Field>
                </div>
                <Field label={t.cron.check} hint={t.help.cronCheck}>
                  <textarea
                    value={job.check ?? ''}
                    onChange={(e) => patch(job.id, { check: e.target.value || undefined })}
                    rows={2}
                    className={textareaClass}
                    placeholder="test -n &quot;$(ls /new-bookings 2>/dev/null)&quot; &amp;&amp; cat /new-bookings/*"
                  />
                </Field>
                <Field label={t.cron.prompt} hint={t.help.cronPrompt}>
                  <textarea value={job.prompt} onChange={(e) => patch(job.id, { prompt: e.target.value })} rows={5} className={textareaClass} />
                </Field>
                <Field label={t.cron.channel} hint={t.help.cronChannel}>
                  <ChannelField
                    value={job.notifyChannelId ?? ''}
                    onChange={(v) => patch(job.id, { notifyChannelId: v || undefined })}
                    channels={channels.data ?? []}
                  />
                </Field>
                <Field label={t.cron.model} hint={t.help.cronModel}>
                  <BrainModelField
                    value={job.model ? `${job.model.provider}/${job.model.model}` : ''}
                    onChange={(v) => {
                      const slash = v.indexOf('/');
                      patch(job.id, { model: slash > 0 ? { provider: v.slice(0, slash), model: v.slice(slash + 1) } : undefined });
                    }}
                    models={models.data ?? []}
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
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3">
        <button type="button" className="spatial-inline-action" onClick={addJob}><Plus size={14} aria-hidden />{t.cron.addJob}</button>
        <AutoSaveStatus status={autosave.status} onRetry={autosave.retry} />
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.cron.deleteTitle}
        description={deleteTarget ? t.cron.deleteDesc.replace('{name}', deleteTarget.name || t.cron.jobNew) : undefined}
        confirmLabel={t.cron.removeJob}
        onConfirm={() => { if (pendingDelete) removeJob(pendingDelete); setPendingDelete(null); }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
