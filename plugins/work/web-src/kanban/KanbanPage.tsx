import { useState, useMemo } from 'react';
import { KanbanSquare, Columns3, CalendarRange, Plus, Activity, Ban, CheckCircle2 } from 'lucide-react';
import { KanbanBoard } from './KanbanBoard';
import { CalendarView } from './CalendarView';
import { TaskModal } from '../tasks/TaskModal';
import { TaskResultsModal } from '../tasks/TaskResultsModal';
import { taskDayMs, isUnscheduled } from '../tasks/dateRange';
import { runtime } from '../runtime';
import type { DateRange, Task } from '../types';

const { Button, ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar, DateRangeFilter, ErrorState, LoadingState, ModuleHeader, MotionLayoutItem, MotionPresence, ProjectFilterPills, SpatialWorkspaceLayout, WorkspaceMetric } = runtime().components;
const { useAllDeps, useMissions, usePersistentState, useProjectFilter, useSetTaskStatus, useTasks, useToast, useTranslation, useUpdateTask } = runtime().hooks;
const { inRange, isStoredRange, parseRange, serializeRange, taskBlockers } = runtime().utils;

const KANBAN_DEFAULT_RANGE: DateRange = { preset: 'today', from: null, to: null };

export function KanbanPage() {
  const { selectedProject, setProject } = useProjectFilter('elowen.kanban.project');
  const tasks = useTasks(selectedProject === 'all' ? undefined : selectedProject);
  const deps = useAllDeps();
  const missions = useMissions();
  const setStatus = useSetTaskStatus();
  const updateTask = useUpdateTask();
  const { toast } = useToast();
  const { t } = useTranslation();
  // Remember board vs calendar across reloads (F5) until the user switches.
  const [view, setView] = usePersistentState<'board' | 'calendar'>('elowen.kanban.view', 'board', ['board', 'calendar']);
  // Date-range window, persisted as one serialized slot. Defaults to today.
  const [rangeRaw, setRangeRaw] = usePersistentState('elowen.kanban.range', serializeRange(KANBAN_DEFAULT_RANGE), isStoredRange);
  const range = useMemo(() => parseRange(rangeRaw) ?? KANBAN_DEFAULT_RANGE, [rangeRaw]);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewing, setViewing] = useState<Task | null>(null);
  const [createSchedule, setCreateSchedule] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // A finished card shows its result (read-only); a live/open one opens the editor.
  const openTask = (task: Task) =>
    (task.status === 'closed' || task.status === 'cancelled' ? setViewing : setEditing)(task);

  // A task is blocked when any task it depends on is not yet closed/cancelled.
  // Use the full (unfiltered) task set so blockers outside the range are still recognised.
  const byId = new Map((tasks.data ?? []).map((t) => [t.id, t]));
  const blockedBy = new Map<string, Task[]>();
  for (const task of tasks.data ?? []) {
    const blockers = taskBlockers(task.id, deps.data ?? [], byId);
    if (blockers.length > 0) blockedBy.set(task.id, blockers);
  }

  // Apply the date filter client-side. Unscheduled tasks (no scheduled_at, no closed_at) are always
  // visible — only a scheduled_at or closed_at anchors a task to the date window.
  // Epics whose phases are visible are always included so phases don't become orphaned standalone cards.
  const filteredTasks = useMemo(() => {
    const now = Date.now();
    const passes = (t: Task) => {
      if (isUnscheduled(t)) return true;
      const ms = taskDayMs(t);
      return ms === 0 || inRange(ms, range, now);
    };
    const base = (tasks.data ?? []).filter(passes);
    const baseIds = new Set(base.map((t) => t.id));
    const missingEpics = (tasks.data ?? []).filter(
      (t) => t.type === 'epic' && !baseIds.has(t.id) && base.some((p) => p.parent_id === t.id),
    );
    return [...base, ...missingEpics];
  }, [tasks.data, range]);

  const summary = useMemo(() => ({
    open: filteredTasks.filter((task) => task.status === 'open').length,
    active: filteredTasks.filter((task) => task.status === 'in_progress').length,
    blocked: filteredTasks.filter((task) => task.status === 'blocked').length,
    closed: filteredTasks.filter((task) => task.status === 'closed').length,
  }), [filteredTasks]);

  return (
    <>
      <ModuleHeader title={t.page.kanban} count={filteredTasks.length} icon={KanbanSquare} />
      <SpatialWorkspaceLayout
        hero={{
          eyebrow: t.kanban.workspaceEyebrow,
          title: t.page.kanban,
          count: filteredTasks.length,
          description: t.kanban.workspaceIntro,
          mascotState: tasks.isLoading ? 'saving' : tasks.isError ? 'error' : 'idle',
          status: !tasks.isLoading && !tasks.isError ? <span className="workspace-status">{t.kanban.workspaceReady}</span> : undefined,
          action: <Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>,
          metrics: <>
            <WorkspaceMetric label={t.tasks.filterOpen} value={summary.open} icon={Columns3} />
            <WorkspaceMetric label={t.tasks.filterActive} value={summary.active} icon={Activity} />
            <WorkspaceMetric label={t.tasks.filterBlocked} value={summary.blocked} icon={Ban} />
            <WorkspaceMetric label={t.tasks.filterClosed} value={summary.closed} icon={CheckCircle2} />
          </>,
        }}
        navigation={{ sections: [{ id: 'board', label: t.kanban.board, icon: Columns3 }, { id: 'calendar', label: t.kanban.calendar, icon: CalendarRange }], value: view, onChange: (id) => setView(id as 'board' | 'calendar'), ariaLabel: t.page.kanban }}
      >
        <ControlSurfaceDocument>
          <ControlSurfaceToolbar className="flex-wrap justify-end">
            <ProjectFilterPills value={selectedProject} onChange={setProject} variant="dropdown" />
            <DateRangeFilter value={range} onChange={(r) => setRangeRaw(serializeRange(r))} compact />
          </ControlSurfaceToolbar>

          <ControlSurfaceRegister>
            {tasks.isLoading ? <ControlSurfaceState><LoadingState variant={view === 'board' ? 'kanban' : 'cards'} /></ControlSurfaceState> : tasks.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} /></ControlSurfaceState>
              : <MotionPresence mode="wait">
                {view === 'board' ? (
                <MotionLayoutItem key="board">
                <KanbanBoard
                  tasks={filteredTasks}
                  allTasks={tasks.data ?? []}
                  blockedBy={blockedBy}
                  missions={missions.data ?? []}
                  onMove={(id, status) => setStatus.mutate({ id, status }, { onError: (e) => toast(String(e), 'error') })}
                  onSelect={openTask}
                  onEdit={setEditing}
                />
                </MotionLayoutItem>
              ) : (
                <MotionLayoutItem key="calendar">
                <CalendarView
                  tasks={filteredTasks}
                  onSelect={openTask}
                  onCreateDay={(d) => { const dt = new Date(d); dt.setHours(9, 0, 0, 0); setCreateSchedule(dt.toISOString()); }}
                  onReschedule={(id, day) => {
                    const task = (tasks.data ?? []).find((x) => x.id === id);
                    const prev = task?.scheduled_at ? new Date(task.scheduled_at) : null;
                    const dt = new Date(day);
                    dt.setHours(prev ? prev.getHours() : 9, prev ? prev.getMinutes() : 0, 0, 0);
                    updateTask.mutate({ id, patch: { scheduled_at: dt.toISOString() } }, { onError: (e) => toast(String(e), 'error') });
                  }}
                />
                </MotionLayoutItem>
              )}
              </MotionPresence>}
          </ControlSurfaceRegister>
        </ControlSurfaceDocument>
      </SpatialWorkspaceLayout>
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
      {viewing && <TaskResultsModal task={viewing} onClose={() => setViewing(null)} />}
      {creating && <TaskModal onClose={() => setCreating(false)} defaultProjectId={selectedProject === 'all' ? undefined : selectedProject} />}
      {createSchedule && <TaskModal initialSchedule={createSchedule} onClose={() => setCreateSchedule(null)} />}
    </>
  );
}
