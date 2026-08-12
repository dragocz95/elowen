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

// ---- hook shapes --------------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars> {
  mutate(vars: TVars, cb?: { onSuccess?: () => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<unknown>;
  isPending: boolean;
  variables?: TVars;
}

interface SubagentHooks {
  usePluginSubagents(): QueryResult<PluginSubagent[]>;
  useSavePluginSubagent(): MutationResult<{ name: string; def: { description: string; tools: PluginSubagent['tools']; body: string } }>;
  useDeletePluginSubagent(): MutationResult<string>;
  usePluginStrings(plugin: string): Record<string, string>;
}

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core original without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface SubagentComponents {
  Badge: AnyComponent; Input: AnyComponent; Field: AnyComponent; SettingsGroup: AnyComponent;
  MarkdownAssetEditor: AnyComponent;
}

interface SubagentRuntime {
  components: SubagentComponents;
  hooks: SubagentHooks;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[] }>;
interface SubagentRegistration {
  requiresApiVersion: number;
  settings?: Record<string, PluginPageComponent>;
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
