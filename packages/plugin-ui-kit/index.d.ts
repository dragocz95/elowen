/** Contract types for Elowen plugin browser UIs — the ONE source of truth shared by the web app
 *  (which installs `window.ElowenUiRuntime` and consumes registrations) and plugin bundles (which
 *  read the runtime and call `window.__elowenRegisterPluginUi`). The web app's `web/lib/pluginUi.ts`
 *  imports these types; keep the two sides in lockstep by editing THIS file only. */
import type * as React from 'react';
import type * as ReactDom from 'react-dom';
import type * as JsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';

/** See index.js — bump on incompatible changes to `ElowenUiRuntime`. Deliberately a LITERAL type:
 *  the web app re-declares the value and annotates it with `typeof PLUGIN_UI_API_VERSION`, so a kit
 *  bump that forgets the host fails the web typecheck instead of drifting silently. */
export declare const PLUGIN_UI_API_VERSION: 1;

/** Props every plugin page/settings component receives. */
export interface PluginPageProps {
  plugin: string;
  /** Path params captured by `:name` segments of the matched route pattern. */
  params: Record<string, string>;
  /** The raw path segments under /p/<plugin>/. */
  rest: string[];
}

/** What a bundle hands to window.__elowenRegisterPluginUi. Routes are `/`-joined segment patterns
 *  (`''` = the root page, `detail/:id` captures params). `settings` components are keyed by the
 *  manifest's `web.settings[].id` and render inside the Settings page's control deck. */
export interface PluginUiRegistration {
  requiresApiVersion: number;
  pages?: Record<string, ComponentType<PluginPageProps>>;
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
  api: (path: string, init?: RequestInit) => Promise<unknown>;
  navigate: (href: string) => void;
}

declare global {
  interface Window {
    ElowenUiRuntime?: ElowenUiRuntime;
    __elowenRegisterPluginUi?: (plugin: string, registration: PluginUiRegistration) => void;
  }
}
