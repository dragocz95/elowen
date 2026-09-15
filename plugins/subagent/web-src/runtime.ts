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

/** One pickable brain model, as the host's `/brain/models` serves it. */
export interface BrainModelOption { provider: string; providerLabel: string; model: string }

/** The account's own values for ONE plugin, as `/plugins/user-config` returns them. `revision` is the CAS
 *  token a save must carry so a stale tab cannot overwrite a newer one. */
export interface UserPluginConfigDetail {
  name: string;
  config: Record<string, unknown>;
  revision: number;
}

/** The provider/model pair encoding every model picker in the app writes. `::` cannot occur in a provider
 *  id while a model id may contain slashes and colons, which is why the pair is not joined with one; an
 *  empty key means "no explicit pick". Mirrors the host's `roleKey` and the server-side parser in
 *  ../lib/typeModel.mjs — a bundle must not import either, so the encoding is restated here. */
export const roleKey = (providerId: string, model: string): string => (providerId && model ? `${providerId}::${model}` : '');

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
  /** The signed-in account's own per-plugin values — the store behind the built-in agent model pins. */
  useUserPluginConfigs(): QueryResult<UserPluginConfigDetail[]>;
  useSaveUserPluginConfig(): MutationResult<{ name: string; values: Record<string, unknown>; expectedRevision?: number }>;
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
