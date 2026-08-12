/** Typed access to the host's window.ElowenUiRuntime for the skills plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks` records; this module narrows each entry to
 *  the signature the moved skills editor was written against in the core app. The narrowing is a
 *  local structural CONTRACT, not a source import — the bundle must not compile against `web/`. */
import type { ComponentType } from 'react';

// ---- data shapes (structural mirrors of the daemon's wire types) --------------------------------

export interface PluginSkill {
  name: string;
  description: string;
  source: 'bundled' | 'user';
  canDelete: boolean;
  disableModelInvocation: boolean;
  version: number | null;
  content?: string;
}

// ---- hook shapes --------------------------------------------------------------------------------

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; refetch(): void }
interface MutationResult<TVars> {
  mutate(vars: TVars, cb?: { onSuccess?: () => void; onError?: (e: unknown) => void }): void;
  mutateAsync(vars: TVars): Promise<unknown>;
  isPending: boolean;
  variables?: TVars;
}

interface SkillsHooks {
  useToast(): { toast: (msg: string, tone?: 'ok' | 'error') => void };
  usePluginSkills(): QueryResult<PluginSkill[]>;
  useCreatePluginSkill(): MutationResult<{ name: string; description: string; content: string; disableModelInvocation?: boolean }>;
  useUpdatePluginSkill(): MutationResult<{ name: string; patch: { description?: string; content?: string; disableModelInvocation?: boolean } }>;
  useDeletePluginSkill(): MutationResult<string>;
  usePluginStrings(plugin: string): Record<string, string>;
}

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core original without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface SkillsComponents {
  Badge: AnyComponent; Toggle: AnyComponent; SettingsGroup: AnyComponent; PluginSection: AnyComponent;
  MarkdownAssetEditor: AnyComponent;
}

interface SkillsRuntime {
  components: SkillsComponents;
  hooks: SkillsHooks;
  utils: { apiErrorMessage(e: unknown): string };
  api(path: string, init?: RequestInit): Promise<unknown>;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface SkillsRegistration {
  requiresApiVersion: number;
  settings?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: SkillsRegistration) => void;
}

/** The host runtime, narrowed. The settings deck loads the bundle only after installing the runtime,
 *  so a missing global here is a programming error worth throwing on. */
export function runtime(): SkillsRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as SkillsRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's settings components on the host (no-op outside the plugin-UI host page). */
export function registerSkillsUi(registration: SkillsRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('skills', registration);
}
