import type { ComponentType } from 'react';

type AnyComponent = ComponentType<any>;

export interface Project { id: number; slug: string; path: string }
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
interface QueryClient { invalidateQueries(input: { queryKey: unknown[] }): Promise<void> }
interface RuntimeHooks {
  usePluginStrings(plugin: string): Record<string, string>;
  useToast(): { toast(message: string, tone?: 'ok' | 'error'): void };
  useQuery<T>(options: Record<string, unknown>): QueryResult<T>;
  useMutation<TData, _TError, TVars>(options: Record<string, unknown>): MutationResult<TVars, TData>;
  useQueryClient(): QueryClient;
}
interface RuntimeComponents {
  Button: AnyComponent; Input: AnyComponent; Badge: AnyComponent; Field: AnyComponent;
  SelectMenu: AnyComponent; Modal: AnyComponent; ModalBody: AnyComponent; ModalFooter: AnyComponent;
  LoadingState: AnyComponent; ErrorState: AnyComponent; EmptyState: AnyComponent;
  SpatialWorkspaceLayout: AnyComponent; WorkspaceMetric: AnyComponent; WorkspaceDetailRail: AnyComponent;
  DataTable: AnyComponent; DataTableRow: AnyComponent; DataTableCell: AnyComponent;
  PatchView: AnyComponent; ConfirmDialog: AnyComponent; PluginSection: AnyComponent;
  SettingsDocument: AnyComponent; SettingsGroup: AnyComponent; SettingsRow: AnyComponent;
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

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface Registration { requiresApiVersion: number; settings: Record<string, PluginPageComponent> }
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
