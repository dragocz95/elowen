'use client';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Plus, ListChecks, Search, Archive, Trash2, X, ChevronLeft, ChevronRight, CalendarDays, List, Activity, Ban, Rocket } from 'lucide-react';
import type { Task, TaskStatus } from '../../lib/types';
import { useTasks, useAllDeps, useSessions, useSessionSignals, useMissions } from '../../lib/queries';
import { taskBlockers, taskSessionName } from '../../lib/agentUtils';
import { epicChildren, phaseIds, epicLive, epicEffectiveStatus } from '../../lib/taskTree';
import { useCloseTask, useDeleteTask } from '../../lib/mutations';
import { TaskDetailPane } from './TaskDetailPane';
import { MissionFlow } from './MissionFlow';
import { EpicGroup } from './EpicGroup';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Segmented } from '../../components/ui/Segmented';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePersistentState } from '../../lib/usePersistentState';
import { useProjectFilter } from '../../lib/useProjectFilter';
import { ProjectFilterPills } from '../../components/ui/ProjectFilterPills';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { TaskCard } from './TaskCard';
import { TaskModal } from './TaskModal';
import { useTaskContextMenu } from './useTaskContextMenu';
import { useTaskDrop } from './useTaskDrop';
import { DateRangeFilter } from '../../components/ui/DateRangeFilter';
import { DEFAULT_RANGE, serializeRange, parseRange, isStoredRange, inRange } from '../../lib/dateRange';
import { taskDayMs } from './dateRange';
import { dayKey } from '../kanban/calendar';
import { MotionLayout, MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { WorkspaceDetailRail, WorkspaceHeader, WorkspaceMetric, WorkspaceMetrics, WorkspacePage } from '../../components/ui/WorkspacePrimitives';

type Filter = 'all' | TaskStatus | 'autopilot';
const FILTER_VALUES: readonly Filter[] = ['all', 'open', 'in_progress', 'blocked', 'closed', 'cancelled', 'autopilot'];
const PAGE_SIZE = 12;

/** Day key from epoch ms — delegates to the canonical local YYYY-MM-DD key (single source of truth). */
const dayKeyMs = (ms: number): string => dayKey(new Date(ms));

export function TasksView() {
  const deps = useAllDeps();
  const sessions = useSessions();
  const signals = useSessionSignals();
  const missions = useMissions();
  const close = useCloseTask();
  const del = useDeleteTask();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [filter, setFilter] = usePersistentState<Filter>('elowen.tasks.filter', 'in_progress', FILTER_VALUES);
  // Date-range window, persisted as one serialized slot. Defaults to the last 7 days; older work is
  // reached by widening the range (or paging through). Applied caller-side only — the shared /tasks
  // fetch stays unfiltered so Kanban/Timeline/Sidebar keep their full cache.
  const [rangeRaw, setRangeRaw] = usePersistentState('elowen.tasks.range', serializeRange(DEFAULT_RANGE), isStoredRange);
  const range = useMemo(() => parseRange(rangeRaw) ?? DEFAULT_RANGE, [rangeRaw]);
  // Selected project pill — 'all' shows every accessible project; a number narrows the list
  // (server-side via /tasks?project_id=N). Persisted + stale-id-clamped by the shared hook.
  const { selectedProject, setProject } = useProjectFilter('elowen.tasks.project');
  const tasks = useTasks(selectedProject === 'all' ? undefined : selectedProject);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Autopilot epics own their phases; phases are hidden from the flat list and nested instead.
  const childMap = useMemo(() => epicChildren(tasks.data ?? []), [tasks.data]);
  const phaseSet = useMemo(() => phaseIds(tasks.data ?? []), [tasks.data]);
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set());
  const toggleEpic = (id: string) => setExpandedEpics((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'in_progress', label: t.tasks.filterActive },
    { value: 'open', label: t.tasks.filterOpen },
    { value: 'blocked', label: t.tasks.filterBlocked },
    { value: 'closed', label: t.tasks.filterClosed },
    { value: 'autopilot', label: t.tasks.filterAutopilot },
    { value: 'all', label: t.tasks.filterAll },
  ];

  // Command palette: /tasks?new=1 opens the create modal; ?select=<id> opens its detail pane.
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => { if (params.get('new') === '1') { setCreating(true); router.replace('/tasks'); } }, [params, router]);
  useEffect(() => { const s = params.get('select'); if (s) setSelectedId(s); }, [params]);
  // Reveal a deep-linked phase by expanding its parent epic.
  useEffect(() => {
    if (!selectedId) return;
    const task = tasks.data?.find((x) => x.id === selectedId);
    if (task?.parent_id && phaseSet.has(selectedId)) setExpandedEpics((s) => new Set(s).add(task.parent_id as string));
  }, [selectedId, tasks.data, phaseSet]);

  // In the Autopilot filter, auto-expand epics that have a running or needs-input phase
  // so their current work is immediately visible. Collapsed ones stay collapsed otherwise.
  useEffect(() => {
    if (filter !== 'autopilot') return;
    const toExpand = new Set<string>();
    for (const epic of tasks.data ?? []) {
      if (epic.type !== 'epic') continue;
      const kids = childMap.get(epic.id) ?? [];
      if (kids.length === 0) continue;
      const { running } = epicLive(kids, sessions.data ?? [], signals);
      const needs = kids.some((k) => { const s = taskSessionName(k); return s ? signals[s]?.type === 'needs_input' : false; });
      if (running > 0 || needs) toExpand.add(epic.id);
    }
    if (toExpand.size) setExpandedEpics((s) => { const n = new Set(s); for (const id of toExpand) n.add(id); return n; });
  }, [filter, tasks.data, childMap, sessions.data, signals]);

  // Resolve each task's unresolved dependency blockers once for the whole list.
  const blockedBy = useMemo(() => {
    const byId = new Map((tasks.data ?? []).map((x) => [x.id, x]));
    const out = new Map<string, Task[]>();
    for (const task of tasks.data ?? []) {
      const b = taskBlockers(task.id, deps.data ?? [], byId);
      if (b.length > 0) out.set(task.id, b);
    }
    return out;
  }, [tasks.data, deps.data]);

  const ctxMenu = useTaskContextMenu({ onSelect: (x) => setSelectedId(x.id), onEdit: setEditing, childMap, blockedBy, missions: missions.data ?? [] });
  const taskDrop = useTaskDrop(tasks.data ?? [], childMap, phaseSet);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const toggleSelect = (id: string) => setSelected((cur) => { const next = new Set(cur); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const clearSelection = () => setSelected(new Set());
  const bulkClose = () => { selected.forEach((id) => close.mutate(id)); toast(t.tasks.nClosed.replace('{count}', String(selected.size))); clearSelection(); };
  const bulkDelete = () => { selected.forEach((id) => del.mutate(id)); toast(t.tasks.nDeleted.replace('{count}', String(selected.size))); clearSelection(); setConfirmBulkDelete(false); };

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const now = Date.now();
    const matchText = (t: Task) => `${t.title} ${t.id} ${t.description ?? ''}`.toLowerCase().includes(q);
    const isEpicActive = (epic: Task): boolean => {
      const kids = childMap.get(epic.id) ?? [];
      return epicLive(kids, sessions.data ?? [], signals).running > 0
        || kids.some((k) => { const s = taskSessionName(k); return s ? signals[s]?.type === 'needs_input' : false; });
    };
    return (tasks.data ?? [])
      .filter((t) => !phaseSet.has(t.id)) // phases are shown nested inside their epic group
      .filter((t) => {
        if (filter === 'autopilot') {
          // Only epics, and only those with phases; active ones surface to the top.
          if (t.type !== 'epic') return false;
          const kids = childMap.get(t.id) ?? [];
          if (kids.length === 0) return false;
          return true;
        }
        // Epics are filtered by their effective status (derived from phases), not their stale 'open'.
        const kids = t.type === 'epic' ? (childMap.get(t.id) ?? []) : [];
        const effStatus = t.type === 'epic' ? epicEffectiveStatus(t, missions.data ?? [], kids) : t.status;
        if (filter !== 'all' && effStatus !== filter) return false;
        if (!q) return true;
        return matchText(t) || kids.some(matchText);
      })
      .filter((t) => { const ms = taskDayMs(t); return ms === 0 || inRange(ms, range, now); }) // date window (default 7d); dateless tasks never hide
      .sort((a, b) => {
        if (filter === 'autopilot') {
          const aActive = isEpicActive(a);
          const bActive = isEpicActive(b);
          if (aActive !== bActive) return aActive ? -1 : 1;
        }
        return taskDayMs(b) - taskDayMs(a); // newest day first
      });
  }, [tasks.data, deferredQuery, filter, range, childMap, phaseSet, sessions.data, signals, missions.data]);

  // Reset to the first page whenever the result set changes shape.
  useEffect(() => { setPage(0); }, [query, filter, range, selectedProject]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  // Group the current page's cards into day sections, preserving sorted order.
  const dayLabel = useCallback((ms: number): string => {
    const now = new Date();
    const todayKey = dayKeyMs(now.getTime());
    const yesterdayKey = dayKeyMs(now.getTime() - 86400000);
    const k = dayKeyMs(ms);
    if (k === todayKey) return t.tasks.dayToday;
    if (k === yesterdayKey) return t.tasks.dayYesterday;
    return new Date(ms).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  }, [t, locale]);
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: Task[] }[] = [];
    for (const task of pageItems) {
      const ms = taskDayMs(task);
      const k = dayKeyMs(ms);
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(task);
      else out.push({ key: k, label: dayLabel(ms), items: [task] });
    }
    return out;
  }, [pageItems, dayLabel]);

  const summary = useMemo(() => {
    const items = tasks.data ?? [];
    return {
      active: items.filter((task) => task.status === 'in_progress').length,
      blocked: items.filter((task) => task.status === 'blocked').length,
      autopilot: items.filter((task) => task.type === 'epic' && (childMap.get(task.id)?.length ?? 0) > 0).length,
      closed: items.filter((task) => task.status === 'closed').length,
    };
  }, [childMap, tasks.data]);

  return (
    <>
      <ModuleHeader title={t.page.tasks} count={filtered.length} icon={ListChecks} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.tasks.workspaceEyebrow}
          title={t.page.tasks}
          count={tasks.data?.length ?? 0}
          description={t.tasks.workspaceIntro}
          icon={ListChecks}
          status={!tasks.isLoading && !tasks.isError ? <span className="workspace-status">{t.tasks.workspaceReady}</span> : undefined}
          action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>}
        />
        <WorkspaceMetrics visual={<div className="task-core"><ListChecks size={28} strokeWidth={1.25} /></div>} ariaLabel={t.tasks.summary}>
          <WorkspaceMetric label={t.tasks.metricActive} value={summary.active} icon={Activity} />
          <WorkspaceMetric label={t.tasks.metricBlocked} value={summary.blocked} icon={Ban} />
          <WorkspaceMetric label={t.tasks.metricAutopilot} value={summary.autopilot} icon={Rocket} />
          <WorkspaceMetric label={t.tasks.metricClosed} value={summary.closed} icon={Archive} />
        </WorkspaceMetrics>
        <div className="workspace-tabs">
          <div className="min-w-0 overflow-x-auto">
            <Segmented size="sm" value={filter} onChange={(v) => setFilter(v as Filter)} options={FILTERS} variant="line" nowrap aria-label={t.tasks.filterLabel} />
          </div>
        </div>

        <div className="workspace-content">
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-y border-border/80 py-3">
            <div className="relative min-w-[15rem] flex-1">
              <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.tasks.searchPlaceholder} className="pl-9" />
            </div>
            <ProjectFilterPills value={selectedProject} onChange={setProject} variant="dropdown" />
            <DateRangeFilter value={range} onChange={(r) => setRangeRaw(serializeRange(r))} compact />
          </div>

          {tasks.isLoading ? <LoadingState variant="list" />
            : tasks.isError ? <ErrorState message={t.common.daemonUnreachable} onRetry={() => tasks.refetch()} />
            : !tasks.data || tasks.data.length === 0 ? <EmptyState title={t.tasks.empty} description={t.tasks.emptyDescription} icon={ListChecks} action={<Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{t.tasks.newTask}</Button>} />
            : filtered.length === 0 ? <EmptyState title={t.tasks.noMatches} description={t.tasks.noMatchesDescription} icon={Search} />
            : (
              <div className="workspace-master-detail tasks-workspace-grid mt-4" data-detail={selectedId != null}>
                <div className="min-w-0">
                  <MotionLayout className="flex flex-col gap-5">
                    <MotionPresence>
                    {groups.map((group) => (
                      <MotionLayoutItem key={group.key} layoutId={`task-day-${group.key}`} className="task-day-section">
                        <div className="flex items-center gap-3 border-b border-border/70 py-2.5">
                          <CalendarDays size={12} className="shrink-0 text-text-muted" aria-hidden />
                          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{group.label}</span>
                          <span className="h-px flex-1 bg-border" />
                          <span className="inline-flex items-center gap-1 font-mono text-tiny text-text-muted"><List size={11} className="shrink-0" aria-hidden />{group.items.length}</span>
                        </div>
                        <MotionLayout className="flex flex-col">
                          <MotionPresence>
                          {group.items.map((task) => {
                            const kids = childMap.get(task.id);
                            if (task.type === 'epic' && kids && kids.length > 0) {
                              return <MotionLayoutItem key={task.id} layoutId={`task-${task.id}`}><EpicGroup epic={task} phases={kids} effectiveStatus={epicEffectiveStatus(task, missions.data ?? [], kids)} expanded={expandedEpics.has(task.id)} onToggle={() => toggleEpic(task.id)} onEdit={setEditing} onSelect={(item) => setSelectedId(item.id)} onContextMenu={ctxMenu.open} activeId={selectedId} blockedBy={blockedBy} onDropTask={(event) => taskDrop.handleDrop(event, task)} dropTargetValid={draggingId ? taskDrop.isValidTarget(draggingId, task) : undefined} /></MotionLayoutItem>;
                            }
                            return <MotionLayoutItem key={task.id} layoutId={`task-${task.id}`}><TaskCard task={task} onEdit={setEditing} onSelect={(item) => setSelectedId(item.id)} onContextMenu={ctxMenu.open} active={selectedId === task.id} blockers={blockedBy.get(task.id)} selected={selected.has(task.id)} onToggleSelect={toggleSelect} selecting={selected.size > 0} dragging={draggingId === task.id} onDragStart={(event) => { event.dataTransfer.setData('text/plain', task.id); setDraggingId(task.id); }} onDragEnd={() => setDraggingId(null)} onDropTask={(event) => taskDrop.handleDrop(event, task)} dropTargetValid={draggingId ? taskDrop.isValidTarget(draggingId, task) : undefined} /></MotionLayoutItem>;
                          })}
                          </MotionPresence>
                        </MotionLayout>
                      </MotionLayoutItem>
                    ))}
                    </MotionPresence>
                  </MotionLayout>

                  {filtered.length > PAGE_SIZE ? (
                    <div className="flex items-center justify-between border-t border-border py-3">
                      <span className="font-mono text-xs text-text-muted">{t.tasks.pageRange.replace('{from}', String(clampedPage * PAGE_SIZE + 1)).replace('{to}', String(clampedPage * PAGE_SIZE + pageItems.length)).replace('{total}', String(filtered.length))}</span>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" icon={ChevronLeft} disabled={clampedPage === 0} onClick={() => setPage(clampedPage - 1)}>{t.tasks.prevPage}</Button>
                        <Button variant="ghost" disabled={clampedPage >= pageCount - 1} onClick={() => setPage(clampedPage + 1)}>{t.tasks.nextPage}<ChevronRight size={15} className="ml-1" /></Button>
                      </div>
                    </div>
                  ) : null}
                </div>

                {selectedId ? (
                  <WorkspaceDetailRail label={t.tasks.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}>
                    {(() => {
                      const selectedTask = tasks.data?.find((item) => item.id === selectedId);
                      const selectedPhases = selectedTask?.type === 'epic' ? (childMap.get(selectedTask.id) ?? []) : [];
                      if (selectedTask?.type === 'epic' && selectedPhases.length > 0) {
                        return <MissionFlow epic={selectedTask} phases={selectedPhases} activeId={selectedId} onSelectPhase={setSelectedId} onContextMenu={ctxMenu.open} />;
                      }
                      const backToEpic = selectedTask?.parent_id && tasks.data?.some((item) => item.id === selectedTask.parent_id && item.type === 'epic') ? selectedTask.parent_id : null;
                      return <TaskDetailPane taskId={selectedId} onEdit={setEditing} onBack={backToEpic ? () => setSelectedId(backToEpic) : undefined} />;
                    })()}
                  </WorkspaceDetailRail>
                ) : null}
              </div>
            )}
        </div>
      </WorkspacePage>

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-elevated px-3 py-2 shadow-[var(--shadow-raised)] animate-fade-up">
          <span className="px-1 text-sm text-text">{t.tasks.nSelected.replace('{count}', String(selected.size))}</span>
          <Button variant="default" icon={Archive} onClick={bulkClose}>{t.common.close}</Button>
          <Button variant="danger" icon={Trash2} onClick={() => setConfirmBulkDelete(true)}>{t.common.delete}</Button>
          <button type="button" aria-label={t.tasks.clearSelection} onClick={clearSelection} className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-surface hover:text-text"><X size={15} /></button>
        </div>
      )}

      {creating && <TaskModal onClose={() => setCreating(false)} defaultProjectId={selectedProject === 'all' ? undefined : selectedProject} />}
      {editing && <TaskModal task={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={confirmBulkDelete} title={t.tasks.confirmBulkDeleteTitle.replace('{count}', String(selected.size))} description={t.tasks.confirmBulkDeleteDescription} onClose={() => setConfirmBulkDelete(false)} onConfirm={bulkDelete} />
      {ctxMenu.menu}
      {ctxMenu.modals}
      {taskDrop.popup}
    </>
  );
}
