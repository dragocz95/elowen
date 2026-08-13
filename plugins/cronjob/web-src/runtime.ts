/** Typed access to the host's window.ElowenUiRuntime for the cronjob plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks`/`utils` records; this module narrows each
 *  entry to the signature the moved jobs editor was written against in the core app. The narrowing
 *  is a local structural CONTRACT, not a source import — the bundle must not compile against `web/`
 *  (it builds standalone via @elowen/plugin-ui-kit).
 */
import type { ComponentType, ReactNode } from 'react';

// ---- data shapes (structural mirrors of the daemon's wire types) --------------------------------

export interface CronJob {
  id: string; name: string; schedule: string; prompt: string;
  check?: string; hours?: string; notifyChannelId?: string; plain?: boolean;
  model?: { provider: string; model: string };
  /** The account this job belongs to; absent/null = an instance job (admin-created, admin-powered). */
  ownerUserId?: number | null;
  enabled?: boolean; runAt?: string; createdAt?: string; lastRun?: string; lastResult?: string;
}
export interface DiscordChannelOption { id: string; name: string; type: 'channel' | 'thread'; parentName?: string }
export interface BrainModelOption { provider: string; model: string }

export interface ManageSelectionItem {
  id: string; label: string; group: string; groupLabel?: string;
  icon?: ReactNode; badges?: { text: string }[];
}

// ---- hook shapes --------------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars> {
  mutate(vars: TVars, cb?: { onSuccess?: () => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<unknown>;
  isPending: boolean;
}

/** The core translation catalog — the editor reads only host-generic sections (managePicker, common). */
type Dict = Record<string, Record<string, string>>;

interface CronHooks {
  useTranslation(): { t: Dict; locale: string };
  useToast(): { toast: (msg: string, tone?: 'ok' | 'error') => void };
  useCronJobs(enabled?: boolean): QueryResult<CronJob[]>;
  useMe(): QueryResult<{ user?: { id: number; is_admin: boolean; username: string } }>;
  useDiscordChannels(): QueryResult<DiscordChannelOption[]>;
  useBrainModels(): QueryResult<BrainModelOption[]>;
  useSaveCronJob(): MutationResult<CronJob>;
  useDeleteCronJob(): MutationResult<string>;
  useAutoSaveStatus(
    deps: readonly unknown[],
    save: () => Promise<void> | void,
    opts?: { ready?: boolean; savable?: boolean; delay?: number },
  ): { status: 'idle' | 'saving' | 'saved' | 'error'; retry: () => void; flush: () => void };
  usePluginStrings(plugin: string): Record<string, string>;
}

interface CronUtils {
  compactElapsed(ms: number): string;
  parseTs(ts: string | undefined): number | null;
  isValidSchedule(spec: string): boolean;
}

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core original without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface CronComponents {
  Badge: AnyComponent; Button: AnyComponent; Input: AnyComponent; Field: AnyComponent; Toggle: AnyComponent;
  ConfirmDialog: AnyComponent; AutoSaveStatus: AnyComponent; LoadingState: AnyComponent; ErrorState: AnyComponent;
  ManageSelectionModal: AnyComponent; SelectionSummary: AnyComponent; BrainModelField: AnyComponent;
  EmptyState: AnyComponent; Segmented: AnyComponent;
  DataTable: AnyComponent; DataTableRow: AnyComponent; DataTableCell: AnyComponent;
  ControlSurfaceDocument: AnyComponent; ControlSurfaceToolbar: AnyComponent;
  ControlSurfaceRegister: AnyComponent; ControlSurfaceState: AnyComponent;
  PluginSection: AnyComponent;
  SpatialWorkspaceLayout: AnyComponent; WorkspaceMetric: AnyComponent; WorkspaceDetailRail: AnyComponent;
  SettingsGroup: AnyComponent;
}

interface CronRuntime {
  components: CronComponents;
  hooks: CronHooks;
  utils: CronUtils;
  api(path: string, init?: RequestInit): Promise<unknown>;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface CronRegistration {
  requiresApiVersion: number;
  settings?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: CronRegistration) => void;
}

/** The host runtime, narrowed. The settings deck loads the bundle only after installing the runtime,
 *  so a missing global here is a programming error worth throwing on. */
export function runtime(): CronRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as CronRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's settings components on the host (no-op outside the plugin-UI host page). */
export function registerCronUi(registration: CronRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('cronjob', registration);
}
