'use client';
import { useEffect, useState } from 'react';
import { Play, Sparkles, ListChecks, Plus, X, AlertTriangle } from 'lucide-react';
import type { Task, PlanResult } from '../../lib/types';
import { useConfig, useTasks } from '../../lib/queries';
import { useCreateTask, useUpdateTask, useSpawn, useSetTaskExec, usePlanTask } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { taskExec } from '../../lib/taskExec';
import { OrcaApiError, orcaClient } from '../../lib/orcaClient';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Checkbox } from '../../components/ui/Checkbox';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { IconButton } from '../../components/ui/IconButton';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { taskTypeMeta, TASK_TYPES, PRIORITIES } from './taskMeta';

type Mode = 'single' | 'planning';
interface ManualPhase { title: string; type: string }

// ISO (UTC) ↔ <input type="datetime-local"> (local, no seconds/zone).
function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localInputToIso = (v: string): string | null => (v ? new Date(v).toISOString() : null);

export function TaskModal({ task, onClose, initialSchedule }: { task?: Task; onClose: () => void; initialSchedule?: string }) {
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

  const [mode, setMode] = useState<Mode>('single');

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
  const [goal, setGoal] = useState('');
  const [autonomy, setAutonomy] = useState(config?.defaults?.autonomy ?? 'L3');
  const [maxSessions, setMaxSessions] = useState(config?.defaults?.maxSessions ?? 1);
  const [engage, setEngage] = useState(false);
  const [result, setResult] = useState<PlanResult | null>(null);
  const [manual, setManual] = useState(false);
  const [manualPhases, setManualPhases] = useState<ManualPhase[]>([{ title: '', type: 'task' }]);

  const typeLabels: Record<string, string> = {
    task: t.tasks.typeTask,
    bug: t.tasks.typeBug,
    feature: t.tasks.typeFeature,
    epic: t.tasks.typeEpic,
    chore: t.tasks.typeChore,
  };

  const busy = create.isPending || update.isPending || spawn.isPending || setExecM.isPending || plan.isPending;

  async function submitSingle() {
    if (!title.trim()) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: task!.id, patch: { title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), autostart: autostart ? 1 : 0, deps } });
        if (exec !== taskExec(task!.labels)) await setExecM.mutateAsync({ id: task!.id, exec });
        toast(t.tasks.updated.replace('{id}', task!.id));
      } else {
        const created = await create.mutateAsync({ title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), autostart: autostart ? 1 : 0, deps });
        if (exec) await setExecM.mutateAsync({ id: created.id, exec });
        if (launchNow) await spawn.mutateAsync({ taskId: created.id, exec: exec || undefined });
        toast(launchNow ? t.tasks.createdAndLaunched.replace('{title}', created.title) : t.tasks.created.replace('{title}', created.title));
      }
      onClose();
    } catch (e) { toast(String(e), 'error'); }
  }

  async function generate() {
    if (!goal.trim()) return;
    try {
      const r = await plan.mutateAsync({ goal: goal.trim(), exec: exec || undefined, autonomy, maxSessions, engage });
      setResult(r);
      toast(t.tasks.planCreated.replace('{count}', String(r.phases.length)).replace('{m}', r.mission ? t.tasks.autopilotStarted : '.'));
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
      const r = await plan.mutateAsync({ goal: goal.trim(), phases, exec: exec || undefined, autonomy, maxSessions, engage });
      setResult(r);
      toast(t.tasks.planCreated.replace('{count}', String(r.phases.length)).replace('{m}', r.mission ? t.tasks.autopilotStarted : '.'));
    } catch (e) { toast(String(e), 'error'); }
  }

  const execSelect = (
    <Field label={t.tasks.fieldExecutor}>
      <Select value={exec} onChange={(e) => setExec(e.target.value)}>
        <option value="">{t.tasks.defaultExecutor}</option>
        {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
      </Select>
    </Field>
  );

  const titleText = editing ? t.tasks.editTitle.replace('{id}', task!.id) : t.tasks.newTitle;

  return (
    <Modal title={titleText} onClose={onClose} size="xl">
      <div className="flex max-h-[78vh] flex-col gap-5 overflow-y-auto p-5">
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
                <Select value={type} onChange={(e) => setType(e.target.value)}>
                  {TASK_TYPES.map((taskType) => <option key={taskType} value={taskType}>{typeLabels[taskType] ?? taskTypeMeta(taskType).label}</option>)}
                </Select>
              </Field>
              <Field label={t.tasks.fieldPriority}>
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
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
                <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-surface p-1">
                  {depCandidates.map((dep) => (
                    <button type="button" key={dep.id} onClick={() => toggleDep(dep.id)} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-elevated">
                      <Checkbox checked={deps.includes(dep.id)} />
                      <span className="min-w-0 flex-1 truncate text-text">{dep.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{dep.id}</span>
                    </button>
                  ))}
                </div>
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
                <Select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
                  {['L0', 'L1', 'L2', 'L3'].map((l) => <option key={l} value={l}>{l}</option>)}
                </Select>
              </Field>
              <Field label={t.tasks.fieldMaxSessions}>
                <Input type="number" min={1} value={maxSessions} onChange={(e) => setMaxSessions(Number(e.target.value))} />
              </Field>
            </div>
            {execSelect}
            <button type="button" onClick={() => setEngage((v) => !v)} className="flex w-fit items-center gap-2 text-sm text-text">
              <Checkbox checked={engage} />
              {t.tasks.startAutopilot}
            </button>

            {manual && (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-elevated/40 p-3">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t.tasks.manualPhases}</span>
                {manualPhases.map((phase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={phase.title} placeholder={t.tasks.phasePlaceholder.replace('{n}', String(i + 1))} onChange={(e) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} />
                    <Select value={phase.type} onChange={(e) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, type: e.target.value } : r))} className="w-32">
                      {TASK_TYPES.filter((taskType) => taskType !== 'epic').map((taskType) => <option key={taskType} value={taskType}>{typeLabels[taskType] ?? taskTypeMeta(taskType).label}</option>)}
                    </Select>
                    <IconButton icon={X} label={t.tasks.removePhase} onClick={() => setManualPhases((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)} />
                  </div>
                ))}
                <button type="button" onClick={() => setManualPhases((rows) => [...rows, { title: '', type: 'task' }])} className="inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
                  <Plus size={13} aria-hidden /> {t.tasks.addPhase}
                </button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
              {manual
                ? <Button variant="accent" disabled={busy} onClick={createManual}>{t.tasks.createPlan}</Button>
                : <Button variant="accent" icon={Sparkles} disabled={busy || !goal.trim()} onClick={generate}>{busy ? t.tasks.planning : t.tasks.generatePlan}</Button>}
            </div>
          </>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              {t.tasks.createdEpic
                .replace('{id}', result.epic.id)
                .replace('{count}', String(result.phases.length))
                .replace('{m}', result.mission ? t.tasks.autopilotEngaged : '.')}
            </p>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {result.phases.map((p, i) => {
                const meta = taskTypeMeta(p.type);
                const Icon = meta.icon;
                const agent = p.labels?.find((l) => l.startsWith('agent:'))?.slice('agent:'.length);
                return (
                  <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="w-4 shrink-0 font-mono text-xs text-text-muted">{i + 1}</span>
                    <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-text">{p.title}</span>
                    {agent ? <Badge tone="accent">{agent}</Badge> : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end">
              <Button variant="accent" onClick={onClose}>{t.tasks.done}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
