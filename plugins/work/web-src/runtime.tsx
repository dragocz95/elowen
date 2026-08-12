/** Typed access to the host's window.ElowenUiRuntime for the work plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks`/`utils` records (the host cannot know every
 *  plugin's needs); this module narrows each entry to the signature the moved views were written
 *  against in the core app. The narrowing is a local structural CONTRACT, not a source import — the
 *  bundle must not compile against `web/` (it builds standalone via @elowen/plugin-ui-kit).
 *
 *  The plugin owns the work domain end to end — its tables, routes, tools and these pages. What it
 *  deliberately does NOT own is a second browser data plane: the query/mutation hooks below are the
 *  host's, so the pages and the core surfaces that still read tasks (dashboard tiles, the bell) share
 *  ONE react-query cache and ONE SSE invalidation path.
 */
import type { ChangeEvent, ComponentType, ReactNode, MouseEvent } from 'react';
import type {
  ActivityEvent, BrainMessage, CommitLogEntry, DateRange, DerivedSignal, ElowenConfig, LocaleDict,
  Mission, ModelUsage, DayUsage, Note, PlanJob, PlanSubmitResult, Project, SegmentedOption,
  ResetUsageResult, SpatialDeckSection, Task, TokenUsage, Tone, UsageSummary,
} from './types';

// ---- hook result shapes -------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars, TData = unknown> {
  mutate(vars: TVars, cb?: { onSuccess?: (data: TData) => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<TData>;
  isPending: boolean;
}

interface CreateTaskInput { title: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; project_id?: number }
interface UpdateTaskInput { title?: string; type?: string; priority?: string; description?: string; scheduled_at?: string | null; autostart?: number; deps?: string[]; addDep?: string; parent_id?: string }
interface PlanInput { goal: string; name?: string; exec?: string; autoModel?: boolean; pilotExec?: string; overseerExec?: string; autonomy?: string; maxSessions?: number; engage?: boolean; phases?: { title: string; type?: string }[]; project_id?: number; prEnabled?: boolean | null }
interface InsertPhasesInput { phases?: { title: string; type?: string; details?: string }[]; goal?: string; exec?: string; prompt?: string }
interface InsertPhasesResult { epic: Task; phases: Task[] }
interface EngageInput { epicId: string; autonomy: string; maxSessions: number }
/** A commit of a project's history tagged with the project it came from (the timeline's merged stream). */
type TaggedCommit = CommitLogEntry & { projectId: number };

interface WorkHooks {
  // --- app services -----------------------------------------------------------------------------
  useTranslation(): { t: LocaleDict; locale: string };
  useToast(): { toast: (msg: string, tone?: 'ok' | 'error') => void };
  usePersistentState<T extends string>(key: string, initial: T, allowed: readonly T[] | ((raw: string) => boolean)): [T, (v: T) => void];
  /** The persisted project filter the built-in workspaces share, keyed by storage key. */
  useProjectFilter(storageKey: string): { selectedProject: number | 'all'; setProject(value: number | 'all'): void };
  useAutoSaveStatus(
    deps: readonly unknown[],
    save: () => Promise<void> | void,
    opts?: { ready?: boolean; savable?: boolean; delay?: number },
  ): { status: 'idle' | 'saving' | 'saved' | 'error'; retry: () => void; flush: () => void };
  /** Silence-based staleness of a live agent session, for the status dot. */
  useSessionStall(name: string, live: boolean): { state: 'fresh' | 'stalled' | 'stuck'; silenceSec: number };
  /** Shared start/stop/pause controls for one task (owns its own mutations and toasts). */
  useTaskControls(task: Task): { session: string | null; running: boolean; start(): void; stop(): void; pause(): void };
  /** The host's batched react-query reader. Importing react-query in the bundle would create a second
   *  QueryClient context, which reads an empty cache — so it comes across the boundary. */
  useQueries<T>(options: {
    queries: { queryKey: unknown[]; queryFn: () => Promise<T>; staleTime?: number }[];
  }): { data?: T }[];

  // --- domain reads -----------------------------------------------------------------------------
  useTasks(projectId?: number): QueryResult<Task[]>;
  useAllDeps(): QueryResult<{ task_id: string; depends_on_id: string }[]>;
  useMissions(): QueryResult<Mission[]>;
  useSessions(): QueryResult<string[]>;
  useSessionSignals(): Record<string, DerivedSignal>;
  useSessionSignal(name: string): DerivedSignal | undefined;
  useConfig(): QueryResult<ElowenConfig>;
  useProjects(): QueryResult<Project[]>;
  useMe(): QueryResult<{ user?: { id: number; username: string; is_admin: boolean } }>;
  useActivity(type?: string, limit?: number): QueryResult<ActivityEvent[]>;
  useModelUsage(projectId?: number, window?: { fromMs: number; toMs: number }): QueryResult<ModelUsage[]>;
  useUsageByDay(projectId?: number, days?: number): QueryResult<DayUsage[]>;
  useProjectsCommits(projectIds: number[], hours: number, enabled?: boolean): { commits: TaggedCommit[]; isLoading: boolean };
  useProjectChanged(id: number | null, enabled?: boolean): QueryResult<{ changed: string[] }>;
  useProjectChanges(id: number | null, enabled: boolean): QueryResult<{ diff: string }>;
  useProjectCommit(id: number | null, hash: string | null): QueryResult<{ diff: string; files: string[] }>;
  useProjectCommitFileDiff(id: number | null, hash: string | null, path: string | null): QueryResult<{ diff: string }>;
  useTaskConversation(taskId: string | null): QueryResult<ActivityEvent[]>;
  useTaskBrainConversation(taskId: string | null, enabled: boolean): QueryResult<BrainMessage[]>;
  useTaskCommits(taskId: string | null): QueryResult<{ commits: CommitLogEntry[] }>;
  useTaskCommitFileDiff(taskId: string | null, hash: string | null, path: string | null): QueryResult<{ diff: string }>;
  useMissionNotes(target: string | null): QueryResult<Note[]>;
  usePlanJob(jobId: string | null): QueryResult<PlanJob>;
  /** Presence of a sibling plugin: the mission affordances belong to `agents`, the code links to
   *  `editor`. False hides them — the pages never assume a plugin they do not own is loaded. */
  useAgentsPlugin(): boolean;
  useEditorPlugin(): boolean;

  // --- domain writes ----------------------------------------------------------------------------
  useCreateTask(): MutationResult<CreateTaskInput, Task>;
  useUpdateTask(): MutationResult<{ id: string; patch: UpdateTaskInput }, Task>;
  useDeleteTask(): MutationResult<string>;
  useCloseTask(): MutationResult<string>;
  useSetTaskStatus(): MutationResult<{ id: string; status: string }>;
  useSetTaskExec(): MutationResult<{ id: string; exec: string }>;
  useSpawn(): MutationResult<{ taskId: string; exec?: string }, { session: string }>;
  usePlanTask(): MutationResult<PlanInput, PlanSubmitResult>;
  useInsertPhases(): MutationResult<{ epicId: string; body: InsertPhasesInput }, InsertPhasesResult>;
  useEngage(): MutationResult<EngageInput, Mission>;
  usePauseMission(): MutationResult<string>;
  useResumeMission(): MutationResult<string>;
  useDisengage(): MutationResult<string>;
  useDeleteMission(): MutationResult<string, { ok: boolean; tasks: number }>;
  useOpenMissionPr(): MutationResult<string, { url: string; number: number }>;
  useMergeMissionPr(): MutationResult<string>;
  useApproveGate(): MutationResult<string, { released: string[] }>;
  useKillSession(): MutationResult<string>;
  useSendInput(): MutationResult<{ name: string; keys: string[] }>;
  useResetUsage(): MutationResult<void, ResetUsageResult>;
}

interface DepEdge { task_id: string; depends_on_id: string }
interface TaskTimeLabel { label: string; title: string }
type IconComponent = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

interface WorkUtils {
  // task/agent mapping
  taskExec(labels?: string[]): string;
  taskAgentName(task: Pick<Task, 'labels'>): string | null;
  taskSessionName(task: Pick<Task, 'labels'>): string | null;
  taskStartedMs(task: Pick<Task, 'labels' | 'created_at'>): number | null;
  taskElapsedMs(task: Pick<Task, 'labels' | 'created_at' | 'closed_at' | 'status' | 'parent_id'>, nowMs: number): number | null;
  taskElapsed(task: Pick<Task, 'labels' | 'created_at' | 'closed_at' | 'status'>, nowMs: number): string | null;
  taskBlockers(taskId: string, deps: DepEdge[], byId: Map<string, Task>): Task[];
  agentDisplayName(session: string): string;
  phaseDetails(description?: string | null): string;
  // epic/phase tree
  epicChildren(tasks: Task[]): Map<string, Task[]>;
  phaseIds(tasks: Task[]): Set<string>;
  epicProgress(children: Task[]): { done: number; total: number };
  epicLive(children: Task[], sessions: string[], signals: Record<string, DerivedSignal>): { running: number; needsInput: number };
  epicEffectiveStatus(epic: Task, missions: Mission[], children?: Task[]): Task['status'];
  // date window
  DEFAULT_RANGE: DateRange;
  serializeRange(r: DateRange): string;
  parseRange(raw: string): DateRange | null;
  isStoredRange(raw: string): boolean;
  rangeBounds(r: DateRange, now: number): { fromMs: number; toMs: number };
  inRange(ms: number, r: DateRange, now: number): boolean;
  rangeWindowCapHours(r: DateRange, now: number): number;
  // formatting
  parseTs(iso?: string | null): number | null;
  formatCost(usd: number, decimals?: number): string;
  formatDuration(ms: number): string;
  formatTaskTime(iso: string | null | undefined, nowMs: number, locale?: string): TaskTimeLabel;
  baseName(p: string): string;
  dirName(p: string): string;
  fileIcon(path: string): IconComponent;
  copyText(text: string): Promise<boolean>;
  // presentation vocabulary shared with the core surfaces that still render task shapes
  taskTypeMeta(type?: string): { icon: IconComponent; label: string; tone: Tone };
  statusTone(status: Task['status']): Tone;
  eventIcon(type: string): IconComponent;
  TONE_TEXT: Record<Tone, string>;
  contextMenuDivider: 'divider';
  // models + usage
  allModels(custom?: { label: string; exec: string }[], hidden?: string[]): { label: string; exec: string }[];
  execModel(exec: string): string;
  buildUsageSummary(data: ModelUsage[] | undefined): UsageSummary;
  // host services
  openTerminalWindow(name: string): void;
  apiErrorMessage(e: unknown): string;
  /** The app's ONE HTTP client, narrowed to the calls these views make directly. */
  elowenClient: {
    taskDeps(id: string): Promise<string[]>;
    taskUsage(id: string): Promise<TokenUsage | null>;
  };
  ElowenApiError: new (...args: never[]) => Error & { code?: string; status?: number };
}

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core originals without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;
/** Open props with ONE callback pinned down. The views pass inline arrows to these handlers, and an
 *  `any`-propped component would leave their parameters implicitly `any` — the one place where the
 *  loose component typing above would silently stop checking real view logic. */
type PropsWith<T> = Record<string, unknown> & T;
type ChoiceComponent = ComponentType<PropsWith<{ onChange?(value: string): void }>>;
type TextInputComponent = ComponentType<PropsWith<{ onChange?(e: ChangeEvent<HTMLInputElement>): void }>>;
type RangeComponent = ComponentType<PropsWith<{ onChange?(range: DateRange): void }>>;
type WorkspaceLayoutComponent = ComponentType<PropsWith<{
  navigation?: { sections: SpatialDeckSection[] | SegmentedOption[]; value: string; onChange(id: string): void; ariaLabel?: string };
}>>;

interface WorkComponents {
  ActionMenu: AnyComponent; AgentIdentityStrip: AnyComponent; AgentStatusDot: AnyComponent;
  AutoSaveStatus: AnyComponent; BackendPicker: ChoiceComponent; Badge: AnyComponent; Button: AnyComponent;
  Checkbox: AnyComponent; ConfirmDialog: AnyComponent; ContextMenu: AnyComponent;
  ControlSurfaceDocument: AnyComponent; ControlSurfaceRegister: AnyComponent;
  ControlSurfaceState: AnyComponent; ControlSurfaceToolbar: AnyComponent;
  DataTable: AnyComponent; DataTableCell: AnyComponent; DataTableRow: AnyComponent;
  DateRangeFilter: RangeComponent; EmptyState: AnyComponent; ErrorState: AnyComponent;
  ExecutorPicker: ChoiceComponent; Field: AnyComponent; IconButton: AnyComponent; Input: TextInputComponent;
  LiveTail: AnyComponent; LoadingState: AnyComponent; Modal: AnyComponent; ModalBody: AnyComponent;
  ModalFooter: AnyComponent; ModelIcon: AnyComponent; ModuleHeader: AnyComponent;
  MotionLayout: AnyComponent; MotionLayoutItem: AnyComponent; MotionPresence: AnyComponent;
  OutcomeBadge: AnyComponent; PatchView: AnyComponent; ProgressRibbon: AnyComponent;
  ProjectFilterPills: AnyComponent; ProjectIcon: AnyComponent; ProjectPill: AnyComponent;
  Segmented: ChoiceComponent; SpatialWorkspaceLayout: WorkspaceLayoutComponent; Spinner: AnyComponent;
  TaskContextLine: AnyComponent; TaskUsageBadge: AnyComponent; TerminalModal: AnyComponent;
  Toggle: AnyComponent; WorkspaceDetailRail: AnyComponent; WorkspaceMetric: AnyComponent;
}

interface WorkRuntime {
  components: WorkComponents;
  hooks: WorkHooks;
  utils: WorkUtils;
  api(path: string, init?: RequestInit): Promise<unknown>;
  navigate(href: string): void;
}

// Deliberately CAST rather than `declare global`: the web app's test build compiles these sources
// alongside the kit's own Window declarations, and two ambient declarations of the same property
// must agree exactly. Local casts keep this compile unit merge-free in both builds.
type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface WorkRegistration {
  requiresApiVersion: number;
  pages?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: WorkRegistration) => void;
}

/** The host runtime, narrowed. The /p/<plugin> host page loads the bundle only after installing the
 *  runtime, so a missing global here is a programming error worth throwing on. */
export function runtime(): WorkRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as WorkRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's pages on the host (no-op outside the plugin-UI host page). */
export function registerWorkUi(registration: WorkRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('work', registration);
}

/** SPA link — replaces next/link in the moved views (plain anchor + host router navigation). */
export function Link({ href, className, title, children }: { href: string; className?: string; title?: string; children?: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // keep open-in-new-tab
    e.preventDefault();
    runtime().navigate(href);
  };
  return <a href={href} className={className} title={title} onClick={onClick}>{children}</a>;
}

/** next/navigation's `useSearchParams`, for a page that owns its query string outside Next's router.
 *  Reads `window.location.search` — the host route is client-rendered, so it is always current. */
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
}

/** The slice of next/navigation's router the moved views use: `replace` drops the query string
 *  without a history entry (parity with the core page's `router.replace('/tasks')`). */
export function useRouter(): { replace(href: string): void; push(href: string): void } {
  return {
    replace: (href: string) => { window.history.replaceState(null, '', href); },
    push: (href: string) => { runtime().navigate(href); },
  };
}
