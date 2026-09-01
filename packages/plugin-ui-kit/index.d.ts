/** Contract types for Elowen plugin browser UIs — the ONE source of truth shared by the web app
 *  (which installs `window.ElowenUiRuntime` and consumes registrations) and plugin bundles (which
 *  read the runtime and call `window.__elowenRegisterPluginUi`). The web app's `web/lib/pluginUi.tsx`
 *  imports these types; keep the two sides in lockstep by editing THIS file only. */
import type * as React from 'react';
import type * as ReactDom from 'react-dom';
import type * as JsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';

/** See index.js — bump on incompatible changes to `ElowenUiRuntime`. Deliberately a LITERAL type:
 *  the web app re-declares the value and annotates it with `typeof PLUGIN_UI_API_VERSION`, so a kit
 *  bump that forgets the host fails the web typecheck instead of drifting silently. */
export declare const PLUGIN_UI_API_VERSION: 12;

/** Public props of `ElowenUiRuntime.components.Slider`. */
export interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'type'> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** Public props of `ElowenUiRuntime.components.DirectoryPicker`. Selection reports the currently open
 *  server directory; closing has no side effect. */
export interface DirectoryPickerProps {
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export interface PluginConfigField {
  key: string;
  label: string;
  type:
    | 'string' | 'secret' | 'boolean' | 'number' | 'textarea' | 'rolePolicies' | 'model' | 'provider'
    | 'section' | 'enum' | 'multiSelect' | 'code' | 'prompt' | 'json' | 'embeddingModel' | 'mcpServers'
    | 'destination' | 'projects' | 'plugins' | 'tools' | 'models' | 'timezone' | 'tokenList';
  hint?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  display?: { control?: 'input' | 'slider'; unit?: string; divisor?: number };
  browse?: 'directory';
  default?: string | number | boolean | string[];
  providerType?: string;
  options?: { value: string; label: string }[];
  language?: string;
  help?: string;
  risk?: 'low' | 'medium' | 'high';
  advanced?: boolean;
  fullWidth?: boolean;
  visibleWhen?: { key: string; equals: string | number | boolean };
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'error';

export interface AutoSaveStatusProps {
  status: SaveStatus;
  onRetry?: () => void | Promise<void>;
}

export interface UseAutoSaveStatusOptions {
  ready?: boolean;
  savable?: boolean;
  delay?: number;
}

export interface UseAutoSaveStatusResult {
  status: SaveStatus;
  retry: () => Promise<void>;
  flush: () => Promise<SaveStatus>;
}

export type UseAutoSaveStatus = (
  deps: readonly unknown[],
  save: () => unknown | Promise<unknown>,
  options?: UseAutoSaveStatusOptions,
) => UseAutoSaveStatusResult;

export type PluginConfigErrorKind = 'validation' | 'conflict' | 'transport';

export interface PluginConfigDraft {
  values: Record<string, unknown>;
  setValue: (key: string, value: unknown) => void;
  commitValue: (key: string, value: unknown) => Promise<{ pending: boolean }>;
  status: SaveStatus;
  errorKind: PluginConfigErrorKind | null;
  retry: () => Promise<void>;
  flush: () => Promise<SaveStatus>;
  ready: boolean;
}

export type UsePluginConfigDraft = (
  name: string,
  detail: { config: Record<string, unknown>; configSchema: readonly PluginConfigField[]; revision?: number },
  options?: { save?: (value: { name: string; values: Record<string, unknown>; expectedRevision?: number }) => Promise<unknown> },
) => PluginConfigDraft;

export type ConfirmDialogButtonVariant = 'default' | 'accent' | 'ghost' | 'danger' | 'ghost-danger' | 'outline' | 'outline-danger';

/** Public props of the API 11 async-safe `ElowenUiRuntime.components.ConfirmDialog`. */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: ConfirmDialogButtonVariant;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  /** Legacy confirm-only disable; unlike `disabled`, Cancel remains available. */
  confirmDisabled?: boolean;
  error?: React.ReactNode;
  /** A promise enables the built-in pending lock; synchronous callbacks remain source-compatible. */
  onConfirm: () => unknown;
  onConfirmError?: (error: unknown) => void;
  onClose: () => void;
}

/** Project metadata exposed to a contextual plugin panel. The Project remains core-owned; a panel uses
 *  this identity to address only its own project-scoped API data. */
export interface PluginUiProject {
  id: number;
  slug: string;
  path: string;
  notes: string;
  icon?: string;
}

/** The selected core User DTO exposed only to administrator user-detail panels. Compatibility fields stay
 * present because plugins receive the same object as the host Users screen, not a second partial identity. */
export interface PluginUiUser {
  id: number;
  username: string;
  created_at: string;
  is_admin: boolean;
  allowed_execs: string[];
  disabled_tools: string[];
  allowed_tools: string[];
  granted_plugins: string[];
  name: string;
  email: string;
  avatar: string;
  default_exec: string;
  advisor_exec: string;
  advisor_autostart: boolean;
}

/** Props every plugin page/settings component receives. */
export interface PluginPageProps {
  plugin: string;
  /** Path params captured by `:name` segments of the matched route pattern. */
  params: Record<string, string>;
  /** The raw path segments under /p/<plugin>/. */
  rest: string[];
  /** Where this component is mounted. A settings component renders in BOTH places: inside the Settings
   *  deck, where the surrounding panel already names the section, and as a standalone page at
   *  /p/<plugin>, where nothing else does — so on a page it owes the reader a page header of its own
   *  (`components.PluginPageHeader`) and must not repeat the section title inside its card. */
  surface: 'page' | 'deck';
  /** Report an autosave state to the surrounding surface, which owns the shared indicator (status plus
   *  the Retry a failed save needs): the page masthead for a section reached at /p/<plugin>, the deck
   *  header for a host that mounts sections in a settings deck. A section that renders its own indicator
   *  inside a group header can ignore it; a section declaring `layout: 'orbital'` cannot — the orbital
   *  group is a field of pods with no header to hold one, so this channel is the only place its user
   *  ever learns that a save failed. */
  onSaveState?: (status: SaveStatus, retry?: () => void | Promise<void>) => void;
}

/** Props for a contextual Project panel. It is never a standalone route: the selected Project and panel
 *  id come from the host's Project detail rail. */
export interface PluginProjectPanelProps {
  plugin: string;
  panelId: string;
  project: PluginUiProject;
  surface: 'project';
}

/** Props for an administrator panel mounted for one selected core User. */
export interface PluginUserPanelProps {
  plugin: string;
  panelId: string;
  user: PluginUiUser;
  surface: 'user';
}

/** What a bundle hands to window.__elowenRegisterPluginUi. Routes are `/`-joined segment patterns
 *  (`''` = the root page, `detail/:id` captures params). Contextual component maps are keyed by their
 *  matching manifest panel ids and mount only in the corresponding host surface. */
export interface PluginUiRegistration {
  requiresApiVersion: number;
  pages?: Record<string, ComponentType<PluginPageProps>>;
  account?: Record<string, ComponentType<PluginPageProps>>;
  /** For an `account` entry placed as `linkedAccount`: its one-line claim in the CLOSED Linked accounts
   *  summary, keyed by the same panel id. Whether a connector is currently linked is a fact only the
   *  bundle holds, so the host cannot draw this chip on its behalf — but it also must not mount the
   *  PANEL to ask, which is why this is its own entry. Omit it and the summary simply says nothing
   *  about this connector. Draw it with `components.SummaryChip` so it matches the chips beside it. */
  accountChip?: Record<string, ComponentType<PluginPageProps>>;
  user?: Record<string, ComponentType<PluginUserPanelProps>>;
  project?: Record<string, ComponentType<PluginProjectPanelProps>>;
  settings?: Record<string, ComponentType<PluginPageProps>>;
  /** Ids of `settings` sections that draw their OWN page frame — the shell, the masthead and the save
   *  indicator — and therefore want none from the host.
   *
   *  The host serves a plugin's SOLE settings section as its page (`/p/<plugin>`) and wraps it in a
   *  page column plus a masthead, because a section written for the Settings deck brings neither. A
   *  section that renders `components.WorkspaceShell` itself then gets both twice: two nested page
   *  frames, so the gutter and the bottom padding apply twice and the page is measurably narrower than
   *  its sibling registers, above a masthead that is a zero-height row of margin holding an idle save
   *  indicator. Naming the section here is how a bundle says "the frame is mine", and it is a fact only
   *  the bundle holds — the host cannot see what a component renders without mounting it.
   *
   *  A section listed here owns the whole surface, so it also owns showing its own save state and must
   *  not rely on `onSaveState` being displayed anywhere. Ids not present in `settings` are ignored. */
  ownsPageFrame?: string[];
}

/** The host API surface a bundle finds on `window.ElowenUiRuntime`: the HOST's React instance (a
 *  bundle must never ship its own — the build aliases `react` imports here), a curated set of the
 *  app's UI components, an authenticated same-origin `api` fetch, and SPA navigation. */
export interface ElowenUiRuntime {
  apiVersion: number;
  react: typeof React;
  reactDom: typeof ReactDom;
  jsxRuntime: typeof JsxRuntime;
  components: Record<string, ComponentType<never>> & {
    AutoSaveStatus: ComponentType<AutoSaveStatusProps>;
  };
  /** Curated React hooks (i18n, toasts, the app's react-query data hooks). Safe across the boundary:
   *  the bundle runs on the HOST's React instance, so the rules of hooks hold. A bundle narrows each
   *  entry to the signature it expects; an absent name means the host predates the bundle. */
  hooks: Record<string, unknown> & {
    useAutoSaveStatus: UseAutoSaveStatus;
    usePluginConfigDraft: UsePluginConfigDraft;
  };
  /** Curated pure helpers (formatting, session/task mapping, error shaping) shared with bundles. */
  utils: Record<string, unknown>;
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  navigate: (href: string) => void;
}

declare global {
  interface Window {
    ElowenUiRuntime?: ElowenUiRuntime;
    __elowenRegisterPluginUi?: (plugin: string, registration: PluginUiRegistration) => void;
  }
}
