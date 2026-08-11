/** Typed access to the host's window.ElowenUiRuntime for the agents plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks`/`utils` records (the host cannot know every
 *  plugin's needs); this module narrows each entry to the signature the moved views were written
 *  against in the core app. The narrowing is a local structural CONTRACT, not a source import — the
 *  bundle must not compile against `web/` (it builds standalone via @elowen/plugin-ui-kit).
 */
import type { ComponentType, ReactNode, MouseEvent } from 'react';

// ---- data shapes (structural mirrors of the daemon's wire types) --------------------------------

export interface SessionInfo { name: string; role: string; agent: string; missionId?: string; userId?: number; projectId?: number }
interface Task {
  id: string; project_id: number; title: string; type: string; status: string; parent_id: string | null;
  labels: string[]; outcome?: string | null; result_summary?: string | null;
}
type DerivedSignal =
  | { type: 'needs_input'; question: string; options?: { id: string; label: string }[] }
  | { type: 'working' | 'idle' | 'done'; question?: undefined; options?: undefined };
export interface Escalation { taskId: string; epicId?: string; title: string; rationale: string; ts: string; blocked: { id: string; title: string }[] }
export interface PendingAsk { taskId: string; askId: string; title?: string; epicId?: string; question: string; since?: number }

interface ContextMenuItem { label: string; icon?: unknown; onClick?: () => void; danger?: boolean }
export interface ContextMenuState { x: number; y: number; items: (ContextMenuItem | 'divider')[] }

// ---- hook shapes --------------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars> {
  mutate(vars: TVars, cb?: { onSuccess?: () => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<unknown>;
  isPending: boolean;
}

/** The core translation catalog: section → key → string. Deliberately loose — the strings the moved
 *  views read (t.sessions.*, t.escalations.*, t.page.*, …) stay in the core dictionaries. */
type Dict = Record<string, Record<string, string>>;

interface AgentsHooks {
  useTranslation(): { t: Dict; locale: string };
  useToast(): { toast: (msg: string, tone?: 'ok' | 'error') => void };
  usePersistentState<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void];
  useTasks(): QueryResult<Task[]>;
  useConfig(): QueryResult<{ autopilot?: { pilotExec?: string; overseerExec?: string } }>;
  useSessionInfos(): QueryResult<SessionInfo[]>;
  useSessionSignals(): Record<string, DerivedSignal>;
  useSessionSignal(name: string): DerivedSignal | undefined;
  useEscalations(): Escalation[];
  usePendingAsks(): QueryResult<PendingAsk[]>;
  useKillSession(): MutationResult<string>;
  useSendInput(): MutationResult<{ name: string; keys: string[] }>;
  useSetTaskStatus(): MutationResult<{ id: string; status: string }>;
  useResumeMission(): MutationResult<string>;
  useApproveGate(): MutationResult<string>;
  useReplyAsk(): MutationResult<{ taskId: string; askId: string; text: string }>;
}

interface AgentsUtils {
  needsInputSessions(names: string[], signals: Record<string, DerivedSignal>): string[];
  taskForSession(tasks: Task[], name: string): Task | undefined;
  missionEpicId(missionId: string): string;
  keysForOption(id: string): string[];
  agentDisplayName(name: string): string;
  taskExec(labels: string[] | undefined): string;
  execModel(exec: string): string;
  formatTaskTime(ts: string, now: number, locale: string): { label: string; title: string };
  apiErrorMessage(e: unknown): string;
  taskTypeMeta(type: string): { icon: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }> };
  contextMenuDivider: 'divider';
}

// ---- component shapes (props narrowed to what the moved views pass) -----------------------------

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core originals without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface AgentsComponents {
  Button: AnyComponent; Input: AnyComponent; Toggle: AnyComponent; Field: AnyComponent; HelpTip: AnyComponent;
  ModuleHeader: AnyComponent; Segmented: AnyComponent; EntityList: AnyComponent; EntityRow: AnyComponent;
  LoadingState: AnyComponent; ErrorState: AnyComponent; EmptyState: AnyComponent;
  MotionLayoutItem: AnyComponent; MotionPresence: AnyComponent;
  SpatialWorkspaceLayout: AnyComponent; WorkspaceMetric: AnyComponent;
  ControlSurfaceDocument: AnyComponent; ControlSurfaceRegister: AnyComponent;
  ControlSurfaceState: AnyComponent; ControlSurfaceToolbar: AnyComponent;
  ModelIcon: AnyComponent; OutcomeBadge: AnyComponent; ProjectPill: AnyComponent; IconButton: AnyComponent;
  ActionMenu: AnyComponent; ContextMenu: AnyComponent; ChangeStrip: AnyComponent; TaskUsageBadge: AnyComponent;
  ConfirmDialog: AnyComponent; TerminalModal: AnyComponent; LiveTail: AnyComponent; BrainSessionsPanel: AnyComponent;
}

interface AgentsRuntime {
  components: AgentsComponents;
  hooks: AgentsHooks;
  utils: AgentsUtils;
  api(path: string, init?: RequestInit): Promise<unknown>;
  navigate(href: string): void;
}

// Deliberately CAST rather than `declare global`: the web app's test build compiles these sources
// alongside the kit's own Window declarations, and two ambient declarations of the same property
// must agree exactly. Local casts keep this compile unit merge-free in both builds.
type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[] }>;
interface AgentsRegistration {
  requiresApiVersion: number;
  pages?: Record<string, PluginPageComponent>;
  settings?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: AgentsRegistration) => void;
}

/** The host runtime, narrowed. The /p/<plugin> host page loads the bundle only after installing the
 *  runtime, so a missing global here is a programming error worth throwing on. */
export function runtime(): AgentsRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as AgentsRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's pages/settings on the host (no-op outside the plugin-UI host page). */
export function registerAgentsUi(registration: AgentsRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('agents', registration);
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
