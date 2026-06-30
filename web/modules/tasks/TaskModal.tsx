'use client';
import { useEffect, useState } from 'react';
import { Play, Sparkles, ListChecks, Plus, X, AlertTriangle, Pencil, Loader2, FolderGit2 } from 'lucide-react';
import type { Task, PlanResult } from '../../lib/types';
import { useConfig, useTasks, usePlanJob, useProjects } from '../../lib/queries';
import { useCreateTask, useUpdateTask, useSpawn, useSetTaskExec, usePlanTask } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { taskExec } from '../../lib/agentUtils';
import { OrcaApiError, orcaClient } from '../../lib/orcaClient';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Checkbox } from '../../components/ui/Checkbox';
import { Toggle } from '../../components/ui/Toggle';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { IconButton } from '../../components/ui/IconButton';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { LiveTail } from '../../components/terminal/LiveTail';
import { TerminalModal } from '../../components/terminal/TerminalModal';
import { useTranslation } from '../../lib/i18n';
import { taskTypeMeta, taskTypeLabel, TASK_TYPES, PRIORITIES } from './taskMeta';
import { DepPicker } from './DepPicker';

type Mode = 'single' | 'planning';
interface ManualPhase { title: string; type: string }
/** Normalized plan result rendered after creation — fed by both the sync manual path and the async
 *  autopilot job. `engaged` reflects whether a mission was started. */
interface PlanOutcome { epicId: string; phases: { title: string; type: string; agent?: string }[]; engaged: boolean }

/** Project full phase Task rows (manual path) into the lightweight phase shape the outcome renders. */
function phasesFromTasks(tasks: Task[]): PlanOutcome['phases'] {
  return tasks.map((p) => ({ title: p.title, type: p.type ?? 'task', agent: p.labels?.find((l) => l.startsWith('agent:'))?.slice('agent:'.length) }));
}

// ISO (UTC) ↔ <input type="datetime-local"> (local, no seconds/zone).
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localInputToIso = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export function TaskModal({ task, onClose, initialSchedule, initialMode, initialGoal, defaultProjectId }: { task?: Task; onClose: () => void; initialSchedule?: string; initialMode?: 'single' | 'planning'; initialGoal?: string; defaultProjectId?: number }) {
  const editing = !!task;
  const { data: config } = useConfig();
  const models = allModels(config?.customModels, config?.hiddenPresets)
    .filter((m) => !config?.allowedExecs || config.allowedExecs.includes(m.exec));
  const { toast } = useToast();
  const { t } = useTranslation();

  const create = useCreateTask();
  const update = useUpdateTask();
  const setExecM = useSetTaskExec();
  const spawn = useSpawn();
  const plan = usePlanTask();

  const [mode, setMode] = useState<Mode>(initialMode ?? 'single');

  // Which project the task/mission lands in (and the agent runs in). Only offered when the user can
  // reach more than one project; the daemon defaults to its home project when project_id is omitted.
  // Picked value overrides; otherwise fall through to the caller's active project filter (if any —
  // e.g. the Tasks page's project pill), then the first accessible project.
  const { data: projects } = useProjects();
  const [pickedProject, setPickedProject] = useState<number | undefined>(undefined);
  const projectId = pickedProject ?? defaultProjectId ?? projects?.[0]?.id;

  // Single-task fields
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [type, setType] = useState(task?.type ?? 'task');
  const [priority, setPriority] = useState(task?.priority ?? 'P2');
  const [exec, setExec] = useState(task ? taskExec(task.labels) : '');
  const [schedule, setSchedule] = useState(isoToLocalInput(task?.scheduled_at) || isoToLocalInput(initialSchedule));
  const [autostart, setAutostart] = useState<boolean>(!!task?.autostart);
  const [deps, setDeps] = useState<string[]>([]);
  const [launchNow, setLaunchNow] = useState(false);

  const allTasks = useTasks();
  const depCandidates = (allTasks.data ?? []).filter((t) => t.id !== task?.id && t.type !== 'epic' && t.status !== 'closed' && t.status !== 'cancelled');

  // Seed dependencies from the server when editing an existing task.
  useEffect(() => {
    if (!task) return;
    let alive = true;
    orcaClient.taskDeps(task.id).then((d) => { if (alive) setDeps(d); }).catch(() => {});
    return () => { alive = false; };
  }, [task]);
  const toggleDep = (id: string) => setDeps((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  // Warn when another task is scheduled within ~10 minutes of this one.
  const scheduleConflict = (() => {
    const iso = localInputToIso(schedule);
    if (!iso) return undefined;
    const ts = new Date(iso).getTime();
    return (allTasks.data ?? []).find((t) => t.id !== task?.id && t.scheduled_at && Math.abs(new Date(t.scheduled_at).getTime() - ts) < 10 * 60 * 1000);
  })();

  // Planning fields
  const [missionName, setMissionName] = useState(''); // optional short name → epic title (goal stays the brief)
  const [goal, setGoal] = useState(initialGoal ?? '');
  // Seed lazily from config: a `useState(config…)` initializer runs once before the async config has
  // loaded and would freeze the fallback (L3 / 1) even when the saved default differs. The user's pick
  // overrides; otherwise fall through to config, then the constant — so the field tracks config as soon
  // as it arrives, without clobbering an edit.
  const [autonomyPick, setAutonomy] = useState<string | null>(null);
  const [maxSessionsPick, setMaxSessions] = useState<number | null>(null);
  const autonomy = autonomyPick ?? config?.defaults?.autonomy ?? 'L3';
  const maxSessions = maxSessionsPick ?? config?.defaults?.maxSessions ?? 1;
  const [engage, setEngage] = useState(false);
  // Per-task GitHub PR workflow override, mirroring the Projects page tri-state: 'default' inherits the
  // project/global setting, 'on'/'off' force it for this task. Sent as prEnabled true/false/null.
  const [prMode, setPrMode] = useState<'default' | 'on' | 'off'>('default');
  const prEnabled = prMode === 'on' ? true : prMode === 'off' ? false : null;
  // When on, the planner picks a model per phase from the model descriptions; the manual exec picker
  // is hidden and no uniform exec is sent.
  const [autoModel, setAutoModel] = useState(false);
  // Normalized plan outcome shared by the manual (sync) and autopilot (async job) paths.
  const [result, setResult] = useState<PlanOutcome | null>(null);
  const [planJobId, setPlanJobId] = useState<string | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const planJob = usePlanJob(planJobId);
  // Clicking the planner's live tail blows it up into the full PTY terminal — same as any session.
  const [openPlanTerm, setOpenPlanTerm] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualPhases, setManualPhases] = useState<ManualPhase[]>([{ title: '', type: 'task' }]);

  // "Planning" covers both the in-flight request and the time the async job is still resolving.
  const planning = plan.isPending || planJobId !== null;
  const busy = create.isPending || update.isPending || spawn.isPending || setExecM.isPending || planning;

  // React to the async autopilot job: render its phases on done, surface failures, then clear it. Keyed
  // on the job data + id ALONE: it must run on each job-state transition, not when `toast`/`engage`/the
  // translations or setters change identity (those are stable or read at run time) — listing them would
  // re-fire the toast/result on unrelated re-renders.
  useEffect(() => {
    const job = planJob.data;
    if (!job || !planJobId) return;
    if (job.status === 'done') {
      setResult({ epicId: job.epicId ?? '', phases: job.phases, engaged: engage });
      toast(t.tasks.planCreated.replace('{count}', String(job.phases.length)).replace('{m}', engage ? t.tasks.autopilotStarted : '.'));
      setPlanJobId(null);
    } else if (job.status === 'failed') {
      setPlanError(job.error ?? t.tasks.planFailed);
      toast(t.tasks.planFailed, 'error');
      setPlanJobId(null);
    }
  }, [planJob.data, planJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitSingle() {
    if (!title.trim()) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: task!.id, patch: { title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), autostart: autostart ? 1 : 0, deps } });
        if (exec !== taskExec(task!.labels)) await setExecM.mutateAsync({ id: task!.id, exec });
        toast(t.tasks.updated.replace('{id}', task!.id));
      } else {
        const created = await create.mutateAsync({ title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), autostart: autostart ? 1 : 0, deps, project_id: projectId });
        if (exec) await setExecM.mutateAsync({ id: created.id, exec });
        if (launchNow) await spawn.mutateAsync({ taskId: created.id, exec: exec || undefined });
        toast(launchNow ? t.tasks.createdAndLaunched.replace('{title}', created.title) : t.tasks.created.replace('{title}', created.title));
      }
      onClose();
    } catch (e) { toast(String(e), 'error'); }
  }

  async function generate() {
    if (!goal.trim()) return;
    setPlanError(null);
    try {
      // Autopilot planning is async: the endpoint returns a job; the effect renders it on done.
      const r = await plan.mutateAsync({ goal: goal.trim(), name: missionName.trim() || undefined, exec: autoModel ? undefined : (exec || undefined), autoModel, autonomy, maxSessions, engage, project_id: projectId, prEnabled });
      if ('jobId' in r) setPlanJobId(r.jobId);
      else finishSync(r);
    } catch (e) {
      if (e instanceof OrcaApiError && e.code === 'autopilot_key_missing') {
        setManual(true);
        toast(t.tasks.autopilotKeyMissing, 'error');
      } else { toast(String(e), 'error'); }
    }
  }

  async function createManual() {
    const phases = manualPhases.map((p) => ({ title: p.title.trim(), type: p.type })).filter((p) => p.title);
    if (phases.length === 0) { toast(t.tasks.addAtLeastOnePhase, 'error'); return; }
    try {
      const r = await plan.mutateAsync({ goal: goal.trim(), name: missionName.trim() || undefined, phases, exec: exec || undefined, autonomy, maxSessions, engage, project_id: projectId, prEnabled });
      if ('jobId' in r) setPlanJobId(r.jobId); else finishSync(r); // manual returns a PlanResult synchronously
    } catch (e) { toast(String(e), 'error'); }
  }

  // Map a synchronous PlanResult into the normalized outcome and toast the summary.
  function finishSync(r: PlanResult) {
    setResult({ epicId: r.epic.id, phases: phasesFromTasks(r.phases), engaged: !!r.mission });
    toast(t.tasks.planCreated.replace('{count}', String(r.phases.length)).replace('{m}', r.mission ? t.tasks.autopilotStarted : '.'));
  }

  const execSelect = (
    <Field label={t.tasks.fieldExecutor}>
      <ExecutorPicker value={exec} onChange={setExec} models={models} defaultLabel={t.tasks.defaultExecutor} moreLabel={t.tasks.moreModels} />
    </Field>
  );

  const titleText = editing ? t.tasks.editTitle.replace('{id}', task!.id) : t.tasks.newTitle;
  const headerIcon = editing ? Pencil : mode === 'planning' ? Sparkles : ListChecks;

  return (
    <Modal title={titleText} description={editing ? task!.id : undefined} onClose={onClose} size="xl" icon={headerIcon}>
      <ModalBody>
        {!editing && (
          <div className="flex flex-col gap-2">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              options={[
                { value: 'single', label: t.tasks.singleTask, icon: ListChecks },
                { value: 'planning', label: t.tasks.autopilotPlanning, icon: Sparkles },
              ]}
            />
            <p className="text-xs text-text-muted">
              {mode === 'single'
                ? t.tasks.singleTaskDesc
                : t.tasks.autopilotPlanningDesc}
            </p>
          </div>
        )}

        {/* Project picker (pills): where the task/mission — and so the agent — runs. Only shown when
            the user can reach more than one project; one project means no choice to make. Not for an
            existing task (its project is fixed). */}
        {!editing && projects && projects.length > 1 && (
          <Field label={t.tasks.fieldProject} hint={t.tasks.fieldProjectHint}>
            <div className="flex flex-wrap gap-1.5">
              {projects.map((p) => {
                const on = projectId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPickedProject(p.id)}
                    title={p.path}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
                    style={{ transitionDuration: 'var(--motion-fast)' }}
                  >
                    <FolderGit2 size={13} className="shrink-0" aria-hidden />{p.slug}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {(editing || mode === 'single') && (
          <>
            <Field label={t.tasks.fieldTitle}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.tasks.titlePlaceholder} autoFocus />
            </Field>
            <Field label={t.tasks.fieldDetails} hint={t.tasks.detailsHint}>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.tasks.detailsPlaceholder}
                rows={4}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t.tasks.fieldType}>
                <Segmented
                  value={type}
                  onChange={setType}
                  options={TASK_TYPES.map((taskType) => ({ value: taskType, label: taskTypeLabel(t, taskType), icon: taskTypeMeta(taskType).icon }))}
                />
              </Field>
              <Field label={t.tasks.fieldPriority}>
                <Segmented value={priority} onChange={setPriority} options={PRIORITIES.map((p) => ({ value: p, label: p }))} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {execSelect}
              <Field label={t.tasks.fieldSchedule} hint={t.tasks.scheduleHint}>
                <Input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              </Field>
            </div>
            {scheduleConflict && (
              <p className="-mt-2 flex items-center gap-1.5 text-xs text-warning">
                <AlertTriangle size={13} aria-hidden />
                {t.tasks.scheduleConflict.replace('{title}', scheduleConflict.title)}
              </p>
            )}
            {schedule && (
              <button type="button" onClick={() => setAutostart((v) => !v)} className="-mt-1 flex w-fit items-start gap-2 text-left text-sm text-text">
                <Checkbox checked={autostart} className="mt-0.5" />
                <span>{t.tasks.autostart}<span className="mt-0.5 block text-xs text-text-muted">{t.tasks.autostartHint}</span></span>
              </button>
            )}
            {depCandidates.length > 0 && (
              <Field label={t.tasks.fieldDependsOn} hint={t.tasks.dependsOnHint}>
                <DepPicker candidates={depCandidates} selected={deps} onToggle={toggleDep} />
              </Field>
            )}
            {!editing && (
              <button type="button" onClick={() => setLaunchNow((v) => !v)} className="flex w-fit items-center gap-2 text-sm text-text">
                <Checkbox checked={launchNow} />
                {t.tasks.launchImmediately}
              </button>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
              <Button variant="accent" icon={editing ? undefined : (launchNow ? Play : undefined)} disabled={busy || !title.trim()} onClick={submitSingle}>
                {editing ? t.common.save : launchNow ? t.tasks.createAndLaunch : t.tasks.create}
              </Button>
            </div>
          </>
        )}

        {!editing && mode === 'planning' && !result && (
          <>
            <Field label={t.tasks.fieldMissionName} hint={t.tasks.missionNameHint}>
              <Input value={missionName} onChange={(e) => setMissionName(e.target.value)} placeholder={t.tasks.missionNamePlaceholder} />
            </Field>
            <Field label={t.tasks.fieldGoal} hint={t.tasks.goalHint}>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t.tasks.goalPlaceholder}
                rows={4}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label={t.tasks.fieldAutonomy}>
                <Segmented value={autonomy} onChange={setAutonomy} options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} />
              </Field>
              <Field label={t.tasks.fieldMaxSessions}>
                <Input type="number" min={1} value={maxSessions} onChange={(e) => setMaxSessions(Number(e.target.value))} />
              </Field>
            </div>
            <Field label={t.tasks.autoModelLabel} hint={t.tasks.autoModelHint}>
              <Toggle checked={autoModel} onChange={setAutoModel} label={t.tasks.autoModelLabel} />
            </Field>
            <Field label={t.tasks.fieldPrMode} hint={t.tasks.prModeHint}>
              <Segmented
                value={prMode}
                onChange={(v) => setPrMode(v as 'default' | 'on' | 'off')}
                options={[
                  { value: 'default', label: t.tasks.prModeDefault },
                  { value: 'on', label: t.tasks.prModeOn },
                  { value: 'off', label: t.tasks.prModeOff },
                ]}
              />
            </Field>
            {!autoModel && execSelect}
            <button type="button" onClick={() => setEngage((v) => !v)} className="flex w-fit items-center gap-2 text-sm text-text">
              <Checkbox checked={engage} />
              {t.tasks.startAutopilot}
            </button>

            {manual && (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-elevated/40 p-3">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t.tasks.manualPhases}</span>
                {manualPhases.map((phase, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <Input value={phase.title} placeholder={t.tasks.phasePlaceholder.replace('{n}', String(i + 1))} onChange={(e) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} className="min-w-[12rem] flex-1" />
                    <Segmented
                      size="sm"
                      value={phase.type}
                      onChange={(v) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, type: v } : r))}
                      options={TASK_TYPES.filter((taskType) => taskType !== 'epic').map((taskType) => ({ value: taskType, label: taskTypeLabel(t, taskType), icon: taskTypeMeta(taskType).icon }))}
                    />
                    <IconButton icon={X} label={t.tasks.removePhase} onClick={() => setManualPhases((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)} />
                  </div>
                ))}
                <button type="button" onClick={() => setManualPhases((rows) => [...rows, { title: '', type: 'task' }])} className="inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
                  <Plus size={13} aria-hidden /> {t.tasks.addPhase}
                </button>
              </div>
            )}

            {planning && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 rounded-md border border-border bg-elevated/40 px-3 py-2.5 text-sm text-text-muted">
                  <Loader2 size={15} className="shrink-0 animate-spin text-accent" aria-hidden />
                  {t.tasks.planning}
                </div>
                {/* Agent-mode planning runs a repo-aware Pilot in a tmux pane — stream it live under the
                    loader so the user watches the planner think, not just a spinner. Relay-mode planning
                    has no session (synchronous), so this stays hidden until a sessionName arrives. */}
                {planJob.data?.sessionName && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t.tasks.plannerPreview}</span>
                    <LiveTail name={planJob.data.sessionName} lines={16} heightClass="max-h-56" onExpand={() => setOpenPlanTerm(true)} />
                  </div>
                )}
              </div>
            )}
            {/* The planner's full interactive terminal, opened from the live tail above. Portals to
                <body> over this modal; auto-closes when the pilot session is reaped (planning done). */}
            {openPlanTerm && planJob.data?.sessionName && (
              <TerminalModal session={planJob.data.sessionName} onClose={() => setOpenPlanTerm(false)} />
            )}
            {planError && !planning && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{t.tasks.planFailed}: {planError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
              {manual
                ? <Button variant="accent" disabled={busy} onClick={createManual}>{t.tasks.createPlan}</Button>
                : <Button variant="accent" icon={Sparkles} disabled={busy || !goal.trim()} onClick={generate}>{planning ? t.tasks.planning : t.tasks.generatePlan}</Button>}
            </div>
          </>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              {t.tasks.createdEpic
                .replace('{id}', result.epicId)
                .replace('{count}', String(result.phases.length))
                .replace('{m}', result.engaged ? t.tasks.autopilotEngaged : '.')}
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {result.phases.map((p, i) => {
                const meta = taskTypeMeta(p.type);
                const Icon = meta.icon;
                return (
                  <li key={i} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-4 shrink-0 font-mono text-xs text-text-muted">{i + 1}</span>
                    <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-text">{p.title}</span>
                    {p.agent ? <Badge tone="accent">{p.agent}</Badge> : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end">
              <Button variant="accent" onClick={onClose}>{t.tasks.done}</Button>
            </div>
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
