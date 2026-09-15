/** Typed access to the host's window.ElowenUiRuntime for the subagent plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks` records; this module narrows each entry to
 *  the signature the moved sub-agents editor was written against in the core app. The narrowing is a
 *  local structural CONTRACT, not a source import — the bundle must not compile against `web/`. */
import type { ComponentType } from 'react';

// ---- data shapes (structural mirrors of the daemon's wire types) --------------------------------

export interface PluginSubagent {
  name: string;
  description: string;
  tools: 'read-only' | 'all' | 'inherit' | string[];
  source: 'builtin' | 'user';
  canDelete: boolean;
  body?: string;
}

/** One pickable brain model, as the host's `/brain/models` serves it. `exec` is the canonical identity
 *  (`<provider>/<model>`) every model picker stores and the host validates a saved pick against. */
export interface BrainModelOption { provider: string; providerLabel: string; model: string; exec: string }

/** The account's own values for ONE plugin, as `/plugins/user-config` returns them. `revision` is the CAS
 *  token a save must carry so a stale tab cannot overwrite a newer one. */
export interface UserPluginConfigDetail {
  name: string;
  config: Record<string, unknown>;
  revision: number;
}

/** The host's own react-query key for that listing. Reused verbatim so this page and the rest of the app
 *  read one cache; a private key would leave two copies of the same account's settings on screen. */
export const USER_PLUGIN_CONFIGS_KEY = ['user-plugin-configs'] as const;

/** `GET /auth/me`, narrowed to the one fact this page reads: whether the signed-in account administers
 *  this instance, and may therefore author the shared agent definitions. */
export interface Me { user?: { is_admin?: boolean } }

// ---- hook shapes --------------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars> {
  mutate(vars: TVars, cb?: { onSuccess?: () => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<unknown>;
  isPending: boolean;
  /** The last settled outcome. The page owns its save indicator (see `ownsPageFrame`), and these are
   *  what it reports — react-query keeps them until the next mutation starts. */
  isError: boolean;
  isSuccess: boolean;
  variables?: TVars;
}

/** The host's autosave states, mirrored structurally: the bundle passes one to `AutoSaveStatus`. */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/** The host dictionary, narrowed to what this bundle reads (nested string maps). */
type Dict = Record<string, Record<string, string>>;

interface SubagentHooks {
  useTranslation(): { t: Dict; locale: string };
  usePluginSubagents(): QueryResult<PluginSubagent[]>;
  useSavePluginSubagent(): MutationResult<{ name: string; def: { description: string; tools: PluginSubagent['tools']; body: string } }>;
  useDeletePluginSubagent(): MutationResult<string>;
  usePluginStrings(plugin: string): Record<string, string>;
  useBrainModels(): QueryResult<BrainModelOption[]>;
  useMe(): QueryResult<Me>;
  /** The host's raw react-query seam. The account's own per-plugin values are read and written through it
   *  plus `utils.elowenClient`, rather than through a dedicated runtime hook — this page must not require
   *  a plugin UI contract version newer than the one it already declares. */
  useQuery<T>(options: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }): QueryResult<T>;
  useMutation<TData, TVars>(options: {
    mutationFn: (vars: TVars) => Promise<TData>;
    onSuccess?: (data: TData) => void;
  }): MutationResult<TVars>;
  useQueryClient(): {
    setQueryData<T>(key: readonly unknown[], updater: (current: T | undefined) => T | undefined): void;
  };
}

/** The host's pure helpers, narrowed to the typed REST client this bundle calls. */
interface SubagentUtils {
  elowenClient: {
    userPluginConfigs(): Promise<UserPluginConfigDetail[]>;
    saveUserPluginConfig(name: string, values: Record<string, unknown>, expectedRevision?: number): Promise<UserPluginConfigDetail>;
  };
}

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core original without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface SubagentComponents {
  Badge: AnyComponent; Input: AnyComponent; Field: AnyComponent; SettingsGroup: AnyComponent; SettingsRow: AnyComponent;
  PluginSection: AnyComponent;
  SelectMenu: AnyComponent; MarkdownAssetEditor: AnyComponent; Button: AnyComponent;
  BrainModelField: AnyComponent; LoadingLine: AnyComponent; ErrorState: AnyComponent;
  ControlSurfaceDocument: AnyComponent;
  WorkspaceShell: AnyComponent; WorkspaceMetric: AnyComponent; AutoSaveStatus: AnyComponent;
}

interface SubagentRuntime {
  components: SubagentComponents;
  hooks: SubagentHooks;
  utils: SubagentUtils;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface SubagentRegistration {
  requiresApiVersion: number;
  settings?: Record<string, PluginPageComponent>;
  /** Settings sections that draw their own page frame, so the host wraps them in none of its own. */
  ownsPageFrame?: string[];
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: SubagentRegistration) => void;
}

/** The host runtime, narrowed. The settings deck loads the bundle only after installing the runtime,
 *  so a missing global here is a programming error worth throwing on. */
export function runtime(): SubagentRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as SubagentRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's settings components on the host (no-op outside the plugin-UI host page). */
export function registerSubagentUi(registration: SubagentRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('subagent', registration);
}
