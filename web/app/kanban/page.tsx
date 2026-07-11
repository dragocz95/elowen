'use client';
export const dynamic = 'force-dynamic';
import { useState, useMemo } from 'react';
import { KanbanSquare, Columns3, CalendarRange, Plus, Activity, Ban, CheckCircle2 } from 'lucide-react';
import type { Task } from '../../lib/types';
import { useTasks, useAllDeps, useMissions } from '../../lib/queries';
import { taskBlockers } from '../../lib/agentUtils';
import { useSetTaskStatus, useUpdateTask } from '../../lib/mutations';
import { KanbanBoard } from '../../modules/kanban/KanbanBoard';
import { CalendarView } from '../../modules/kanban/CalendarView';
import { TaskModal } from '../../modules/tasks/TaskModal';
import { TaskResultsModal } from '../../modules/tasks/TaskResultsModal';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { inRange, isStoredRange, serializeRange, parseRange } from '../../lib/dateRange';
import type { DateRange } from '../../lib/dateRange';
import { taskDayMs, isUnscheduled } from '../../modules/tasks/dateRange';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { ProjectFilterPills } from '../../components/ui/ProjectFilterPills';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { useProjectFilter } from '../../lib/useProjectFilter';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { Button } from '../../components/ui/Button';
import { WorkspaceHeader, WorkspaceMetric, WorkspaceMetrics, WorkspacePage } from '../../components/ui/WorkspacePrimitives';

const KANBAN_DEFAULT_RANGE: DateRange = { preset: 'today', from: null, to: null };

export default function KanbanPage() {
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
    <ModuleShell moduleId="kanban">
      <ModuleHeader title={t.page.kanban} count={filteredTasks.length} icon={KanbanSquare} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.kanban.workspaceEyebrow}
          title={t.page.kanban}
          count={filteredTasks.length}
          description={t.kanban.workspaceIntro}
          icon={KanbanSquare}
          status={!tasks.isLoading && !tasks.isError ? <span className="workspace-status">{t.kanban.workspaceReady}</span> : undefined}
          action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>}
        />
        <WorkspaceMetrics visual={<div className="kanban-core"><KanbanSquare size={28} strokeWidth={1.25} /></div>} ariaLabel={t.kanban.summary}>
          <WorkspaceMetric label={t.tasks.filterOpen} value={summary.open} icon={Columns3} />
          <WorkspaceMetric label={t.tasks.filterActive} value={summary.active} icon={Activity} />
          <WorkspaceMetric label={t.tasks.filterBlocked} value={summary.blocked} icon={Ban} />
          <WorkspaceMetric label={t.tasks.filterClosed} value={summary.closed} icon={CheckCircle2} />
        </WorkspaceMetrics>
        <div className="workspace-tabs">
          <Segmented
            value={view}
            onChange={(v) => setView(v as 'board' | 'calendar')}
            options={[
              { value: 'board', label: t.kanban.board, icon: Columns3 },
              { value: 'calendar', label: t.kanban.calendar, icon: CalendarRange },
            ]}
            variant="line"
            nowrap
            aria-label={t.page.kanban}
          />
        </div>
        <div className="workspace-content">
          <div className="flex flex-wrap items-center justify-end gap-2 border-y border-border/80 py-3">
            <ProjectFilterPills value={selectedProject} onChange={setProject} variant="dropdown" />
            <DateRangeFilter value={range} onChange={(r) => setRangeRaw(serializeRange(r))} compact />
          </div>

          <div className="mt-4">
            {tasks.isLoading ? <LoadingState variant={view === 'board' ? 'kanban' : 'cards'} /> : tasks.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
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
          </div>
        </div>
      </WorkspacePage>
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
      {viewing && <TaskResultsModal task={viewing} onClose={() => setViewing(null)} />}
      {creating && <TaskModal onClose={() => setCreating(false)} defaultProjectId={selectedProject === 'all' ? undefined : selectedProject} />}
      {createSchedule && <TaskModal initialSchedule={createSchedule} onClose={() => setCreateSchedule(null)} />}
    </ModuleShell>
  );
}
