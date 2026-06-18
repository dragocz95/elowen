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
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { IconButton } from '../../components/ui/IconButton';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
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

export function TaskModal({ task, onClose }: { task?: Task; onClose: () => void }) {
  const editing = !!task;
  const { data: config } = useConfig();
  const models = allModels(config?.customModels, config?.hiddenPresets)
    .filter((m) => !config?.allowedExecs || config.allowedExecs.includes(m.exec));
  const { toast } = useToast();

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
  const [schedule, setSchedule] = useState(isoToLocalInput(task?.scheduled_at));
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

  const busy = create.isPending || update.isPending || spawn.isPending || setExecM.isPending || plan.isPending;

  async function submitSingle() {
    if (!title.trim()) return;
    try {
      if (editing) {
        await update.mutateAsync({ id: task!.id, patch: { title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), deps } });
        if (exec !== taskExec(task!.labels)) await setExecM.mutateAsync({ id: task!.id, exec });
        toast(`Updated ${task!.id}`);
      } else {
        const created = await create.mutateAsync({ title: title.trim(), type, priority, description: description.trim(), scheduled_at: localInputToIso(schedule), deps });
        if (exec) await setExecM.mutateAsync({ id: created.id, exec });
        if (launchNow) await spawn.mutateAsync({ taskId: created.id, exec: exec || undefined });
        toast(launchNow ? `Created & launched ${created.title}` : `Created ${created.title}`);
      }
      onClose();
    } catch (e) { toast(String(e), 'error'); }
  }

  async function generate() {
    if (!goal.trim()) return;
    try {
      const r = await plan.mutateAsync({ goal: goal.trim(), exec: exec || undefined, autonomy, maxSessions, engage });
      setResult(r);
      toast(`Plan created — ${r.phases.length} phases${r.mission ? ' · autopilot started' : ''}`);
    } catch (e) {
      if (e instanceof OrcaApiError && e.code === 'autopilot_key_missing') {
        setManual(true);
        toast('Autopilot key not set — add phases manually', 'error');
      } else { toast(String(e), 'error'); }
    }
  }

  async function createManual() {
    const phases = manualPhases.map((p) => ({ title: p.title.trim(), type: p.type })).filter((p) => p.title);
    if (phases.length === 0) { toast('Add at least one phase', 'error'); return; }
    try {
      const r = await plan.mutateAsync({ goal: goal.trim(), phases, exec: exec || undefined, autonomy, maxSessions, engage });
      setResult(r);
      toast(`Plan created — ${r.phases.length} phases${r.mission ? ' · autopilot started' : ''}`);
    } catch (e) { toast(String(e), 'error'); }
  }

  const execSelect = (
    <Field label="Executor">
      <Select value={exec} onChange={(e) => setExec(e.target.value)}>
        <option value="">Default (fallback)</option>
        {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
      </Select>
    </Field>
  );

  const titleText = editing ? `Edit ${task!.id}` : 'New task';

  return (
    <Modal title={titleText} onClose={onClose} size="xl">
      <div className="flex max-h-[78vh] flex-col gap-5 overflow-y-auto p-5">
        {!editing && (
          <div className="flex flex-col gap-2">
            <Segmented
              value={mode}
              onChange={(v) => setMode(v as Mode)}
              options={[
                { value: 'single', label: 'Single task', icon: ListChecks },
                { value: 'planning', label: 'Autopilot · Planning', icon: Sparkles },
              ]}
            />
            <p className="text-xs text-text-muted">
              {mode === 'single'
                ? 'Create one task and optionally launch a single agent on it.'
                : 'The Pilot breaks your goal into ordered phases, names an agent for each, and can run them autonomously.'}
            </p>
          </div>
        )}

        {(editing || mode === 'single') && (
          <>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
            </Field>
            <Field label="Details" hint="Context handed to the agent — what to build, constraints, acceptance.">
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the task so the agent knows exactly what to do…"
                rows={4}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Type">
                <Select value={type} onChange={(e) => setType(e.target.value)}>
                  {TASK_TYPES.map((t) => <option key={t} value={t}>{taskTypeMeta(t).label}</option>)}
                </Select>
              </Field>
              <Field label="Priority">
                <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {execSelect}
              <Field label="Schedule" hint="Optional — auto-launch at this time.">
                <Input type="datetime-local" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              </Field>
            </div>
            {scheduleConflict && (
              <p className="-mt-2 flex items-center gap-1.5 text-xs text-[#f59e0b]">
                <AlertTriangle size={13} aria-hidden />
                Close to <span className="font-medium text-text">{scheduleConflict.title}</span> — both launch within ~10 min, expect heavier load.
              </p>
            )}
            {depCandidates.length > 0 && (
              <Field label="Depends on" hint="This task waits until the selected tasks are closed.">
                <div className="max-h-32 overflow-y-auto rounded-md border border-border bg-surface p-1">
                  {depCandidates.map((t) => (
                    <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-elevated">
                      <input type="checkbox" checked={deps.includes(t.id)} onChange={() => toggleDep(t.id)} className="accent-accent" />
                      <span className="min-w-0 flex-1 truncate text-text">{t.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{t.id}</span>
                    </label>
                  ))}
                </div>
              </Field>
            )}
            {!editing && (
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={launchNow} onChange={(e) => setLaunchNow(e.target.checked)} className="accent-accent" />
                Launch a session immediately
              </label>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="accent" icon={editing ? undefined : (launchNow ? Play : undefined)} disabled={busy || !title.trim()} onClick={submitSingle}>
                {editing ? 'Save' : launchNow ? 'Create & launch' : 'Create'}
              </Button>
            </div>
          </>
        )}

        {!editing && mode === 'planning' && !result && (
          <>
            <Field label="Goal" hint="The model breaks this into ordered phases.">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="Describe the goal to plan…"
                rows={4}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Autonomy">
                <Select value={autonomy} onChange={(e) => setAutonomy(e.target.value)}>
                  {['L0', 'L1', 'L2', 'L3'].map((l) => <option key={l} value={l}>{l}</option>)}
                </Select>
              </Field>
              <Field label="Max sessions">
                <Input type="number" min={1} value={maxSessions} onChange={(e) => setMaxSessions(Number(e.target.value))} />
              </Field>
            </div>
            {execSelect}
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={engage} onChange={(e) => setEngage(e.target.checked)} className="accent-accent" />
              Start autopilot now (engage mission)
            </label>

            {manual && (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-elevated/40 p-3">
                <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Phases (manual)</span>
                {manualPhases.map((p, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={p.title} placeholder={`Phase ${i + 1}`} onChange={(e) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, title: e.target.value } : r))} />
                    <Select value={p.type} onChange={(e) => setManualPhases((rows) => rows.map((r, j) => j === i ? { ...r, type: e.target.value } : r))} className="w-32">
                      {TASK_TYPES.filter((t) => t !== 'epic').map((t) => <option key={t} value={t}>{taskTypeMeta(t).label}</option>)}
                    </Select>
                    <IconButton icon={X} label="Remove phase" onClick={() => setManualPhases((rows) => rows.length > 1 ? rows.filter((_, j) => j !== i) : rows)} />
                  </div>
                ))}
                <button type="button" onClick={() => setManualPhases((rows) => [...rows, { title: '', type: 'task' }])} className="inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
                  <Plus size={13} aria-hidden /> Add phase
                </button>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              {manual
                ? <Button variant="accent" disabled={busy} onClick={createManual}>Create plan</Button>
                : <Button variant="accent" icon={Sparkles} disabled={busy || !goal.trim()} onClick={generate}>{busy ? 'Planning…' : 'Generate plan'}</Button>}
            </div>
          </>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-muted">
              Created epic <span className="font-mono text-text">{result.epic.id}</span> with {result.phases.length} phases
              {result.mission ? ' — autopilot engaged.' : '.'}
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
              <Button variant="accent" onClick={onClose}>Done</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
