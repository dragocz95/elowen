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
export declare const PLUGIN_UI_API_VERSION: 5;

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
  onSaveState?: (status: 'idle' | 'saving' | 'saved' | 'error', retry?: () => void) => void;
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
  user?: Record<string, ComponentType<PluginUserPanelProps>>;
  project?: Record<string, ComponentType<PluginProjectPanelProps>>;
  settings?: Record<string, ComponentType<PluginPageProps>>;
}

/** The host API surface a bundle finds on `window.ElowenUiRuntime`: the HOST's React instance (a
 *  bundle must never ship its own — the build aliases `react` imports here), a curated set of the
 *  app's UI components, an authenticated same-origin `api` fetch, and SPA navigation. */
export interface ElowenUiRuntime {
  apiVersion: number;
  react: typeof React;
  reactDom: typeof ReactDom;
  jsxRuntime: typeof JsxRuntime;
  components: Record<string, ComponentType<never>>;
  /** Curated React hooks (i18n, toasts, the app's react-query data hooks). Safe across the boundary:
   *  the bundle runs on the HOST's React instance, so the rules of hooks hold. A bundle narrows each
   *  entry to the signature it expects; an absent name means the host predates the bundle. */
  hooks: Record<string, unknown>;
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
