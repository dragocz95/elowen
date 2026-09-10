import type { ComponentType } from 'react';

type AnyComponent = ComponentType<any>;

export interface Project { id: number; slug: string; path: string; executionKind?: 'host' | 'managed'; lifecycle?: 'active' | 'deleting' }
export interface User {
  id: number; username: string; created_at: string; is_admin: boolean; allowed_execs: string[];
  disabled_tools: string[]; allowed_tools: string[]; granted_plugins: string[]; name: string; email: string;
  avatar: string; default_exec: string; advisor_exec: string; advisor_autostart: boolean;
}
export interface Session { id: string; title: string; updatedAt: string }
export interface WorkspaceFile { path: string; code: string; untracked: boolean }
export interface WorkspaceStatus {
  branch: string; head: string; upstream: string | null; ahead: number; behind: number;
  dirty: number; untracked: number; clean: boolean;
}
export interface Workspace {
  id: string; userId: number; projectId: number; label: string; path: string; branch: string; baseRef: string;
  lifecycle: 'active' | 'orphaned'; orphanReason: string | null; createdAt: string; updatedAt: string; lastUsedAt: string;
  accessible: boolean; status: WorkspaceStatus | null; files: WorkspaceFile[]; uniqueCommits: number; activeProcesses: number;
  bindings: { sessionId: string; updatedAt: string }[];
}
export interface Overview { projects: Project[]; sessions: Session[]; workspaces: Workspace[] }
export interface EnvironmentState {
  mode: 'confined' | 'direct' | 'unavailable';
  probe: { available: boolean; reason: string | null };
  networkAvailable: boolean;
  home: { path: string; generation: number; bytes: number; entries: number; truncated: boolean; activeProcesses: number };
  author: { name: string; email: string };
  migrationCollision: boolean;
}

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; error?: unknown; refetch(): void }
interface MutationResult<TVars, TData = unknown> {
  mutate(vars: TVars, callbacks?: { onSuccess?: (data: TData) => void; onError?: (error: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<TData>;
  isPending: boolean;
}
interface QueryClient { invalidateQueries: (input: { queryKey: unknown[] }) => Promise<void> }
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'error';
interface RuntimeHooks {
  usePluginStrings(plugin: string): Record<string, string>;
  useToast(): { toast(message: string, tone?: 'ok' | 'error'): void };
  useQuery<T>(options: Record<string, unknown>): QueryResult<T>;
  useMutation<TData, _TError, TVars>(options: Record<string, unknown>): MutationResult<TVars, TData>;
  /** One read per row of a register: the host's own React Query, so the register's environment states
   *  share the cache (and the pushed invalidation) with every other surface reading them. */
  useQueries<T>(options: { queries: Record<string, unknown>[] }): { data?: T }[];
  useQueryClient(): QueryClient;
  useAutoSaveStatus(
    deps: readonly unknown[],
    save: () => unknown | Promise<unknown>,
    options?: { ready?: boolean; savable?: boolean; delay?: number },
  ): { status: SaveStatus; retry: () => Promise<void>; flush: () => Promise<SaveStatus> };
  /** The host's own dictionary. The progress window's wording belongs to the host component that draws
   *  it, so the bundle reads the same strings rather than shipping a second copy of them. */
  useTranslation(): { t: HostDictionary };
  /** Follow one durable environment operation: one seed read, then the daemon's pushed frames. */
  useEnvironmentOperation(operationId: string | null, projectId?: number): {
    operation: EnvironmentOperationView | null;
    logTail: string[];
    loading: boolean;
    loadError: string | null;
  };
}
/** Only the part of the host dictionary this bundle reads. */
interface HostDictionary { operationProgress: { actions: Record<string, string> } }
export interface EnvironmentOperationView {
  id: string;
  action: { kind: string };
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
  steps: string[];
  stepIndex: number;
  stepTotal: number;
  stepLabel: string | null;
  percent: number | null;
}
interface RuntimeComponents {
  Button: AnyComponent; Input: AnyComponent; Badge: AnyComponent; Field: AnyComponent;
  SelectMenu: AnyComponent; Modal: AnyComponent; ModalBody: AnyComponent; ModalFooter: AnyComponent;
  LoadingState: AnyComponent; ErrorState: AnyComponent; EmptyState: AnyComponent;
  SpatialWorkspaceLayout: AnyComponent; WorkspaceMetric: AnyComponent; WorkspaceDetailRail: AnyComponent;
  DataTable: AnyComponent; DataTableRow: AnyComponent; DataTableCell: AnyComponent; DataTableChevronCell: AnyComponent;
  PatchView: AnyComponent; ConfirmDialog: AnyComponent; OperationProgressDialog: AnyComponent; PluginSection: AnyComponent;
  SettingsDocument: AnyComponent; SettingsGroup: AnyComponent; SettingsRow: AnyComponent;
  Slider: AnyComponent; AutoSaveStatus: AnyComponent; HelpTip: AnyComponent;
  // The host's own preview-plus-manage row, so the account drawer reads the same as its neighbours.
  SelectionSummary: AnyComponent;
}
interface RuntimeUtils {
  apiErrorMessage(error: unknown): string;
  formatDuration(ms: number): string;
}
interface SandboxRuntime {
  components: RuntimeComponents;
  hooks: RuntimeHooks;
  utils: RuntimeUtils;
  api(path: string, init?: RequestInit): Promise<unknown>;
}

type PluginUserComponent = ComponentType<{ plugin: string; panelId: string; user: User; surface: 'user' }>;
type PluginProjectComponent = ComponentType<{ plugin: string; panelId: string; project: Project; surface: 'project' }>;
/** The Project register's row seam: called once per host render with the rows on screen, answering with
 *  a state per project, the actions that state allows, and the dialogs those actions raise. */
type PluginProjectRowsHook = (input: { projects: Project[] }) => {
  status?: Record<number, { label: string; icon?: string; tone?: 'muted' | 'accent' | 'success' | 'warning' | 'danger'; busy?: boolean }>;
  actions?: Record<number, { id: string; label: string; icon?: string; disabled?: boolean; tone?: 'danger'; onSelect: () => void }[]>;
  overlay?: unknown;
};
interface Registration {
  requiresApiVersion: number;
  user?: Record<string, PluginUserComponent>;
  project?: Record<string, PluginProjectComponent>;
  projectRows?: PluginProjectRowsHook;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: Registration) => void;
}

export function runtime(): SandboxRuntime {
  const value = (window as HostWindow).ElowenUiRuntime as SandboxRuntime | undefined;
  if (!value) throw new Error('ElowenUiRuntime is not installed');
  return value;
}

export function registerSandboxUi(registration: Registration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('sandbox', registration);
}

export function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

export function localizedError(error: unknown, strings: Record<string, string>): string {
  const { utils } = runtime();
  const code = utils.apiErrorMessage(error);
  return strings[`error_${code}`] || code || strings.errorFallback;
}
