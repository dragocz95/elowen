'use client';
/** Plugin browser-UI runtime (plugin platform F0).
 *
 *  A plugin ships ONE built same-origin ESM bundle (served by the daemon on an immutable content-hash
 *  URL, listed by GET /plugins/ui). Loading it here is a SCRIPT TAG, not a bundler import — the URL is
 *  runtime data, and a `<script type="module">` is the one mechanism no bundler rewrites. The bundle
 *  talks back through two window globals installed below:
 *
 *    window.ElowenUiRuntime          — the host API surface (react, curated components, hooks, navigate)
 *    window.__elowenRegisterPluginUi — the bundle's registration call (pages + settings components)
 *
 *  Security model, explicitly: an admin-installed plugin already runs inside the daemon process (full
 *  trust ≈ RCE); its browser bundle is the SMALLER privilege. There is no sandbox here and pretending
 *  otherwise would be theatre — marketplace review is the filter. Bundles are same-origin only, so
 *  cookies and the BFF bearer work unchanged and a future CSP needs nothing beyond `script-src 'self'`. */
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as JsxRuntime from 'react/jsx-runtime';
import type { ComponentType } from 'react';
import { BASE } from './elowenClient';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Field } from '../components/ui/Field';
import { HelpTip } from '../components/ui/HelpTip';
import { Modal, ModalBody, ModalFooter } from '../components/ui/Modal';

/** Bump on incompatible changes to the runtime surface below. A bundle requiring a NEWER major renders
 *  a placeholder instead of executing against a contract it was not built for. */
export const PLUGIN_UI_API_VERSION = 1;

/** Props every plugin page/settings component receives. */
export interface PluginPageProps {
  plugin: string;
  /** Path params captured by `:name` segments of the matched route pattern. */
  params: Record<string, string>;
  /** The raw path segments under /p/<plugin>/. */
  rest: string[];
}

/** What a bundle hands to window.__elowenRegisterPluginUi. Routes are `/`-joined segment patterns
 *  (`''` = the root page, `detail/:id` captures params). */
export interface PluginUiRegistration {
  requiresApiVersion: number;
  pages?: Record<string, ComponentType<PluginPageProps>>;
  settings?: Record<string, ComponentType<PluginPageProps>>;
}

/** Same-origin JSON fetch against the daemon through the BFF (`/api` + path). Rejects on non-2xx. */
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`api ${res.status} on ${path}`);
  return res.status === 204 ? undefined : res.json();
}

type Navigate = (href: string) => void;
let navigateImpl: Navigate = (href) => { window.location.assign(href); };
/** The shell installs the SPA router push here (see the /p/[plugin] page); default hard-navigates. */
export function setPluginNavigate(fn: Navigate): void { navigateImpl = fn; }

const registrations = new Map<string, PluginUiRegistration>();
const pendingLoads = new Map<string, Promise<PluginUiRegistration | null>>();

declare global {
  interface Window {
    ElowenUiRuntime?: {
      apiVersion: number;
      react: typeof React;
      reactDom: typeof ReactDom;
      jsxRuntime: typeof JsxRuntime;
      components: Record<string, ComponentType<never>>;
      api: (path: string, init?: RequestInit) => Promise<unknown>;
      navigate: Navigate;
    };
    __elowenRegisterPluginUi?: (plugin: string, registration: PluginUiRegistration) => void;
  }
}

/** Install the window globals exactly once. Idempotent — called from every bundle load. */
function ensurePluginUiRuntime(): void {
  if (typeof window === 'undefined' || window.ElowenUiRuntime) return;
  window.ElowenUiRuntime = {
    apiVersion: PLUGIN_UI_API_VERSION,
    react: React,
    reactDom: ReactDom,
    jsxRuntime: JsxRuntime,
    // Curated, deliberately small: what a plugin page needs to look native. Growing this list is cheap;
    // shrinking it is a breaking change — so it starts minimal.
    components: { Button, Input, Badge, Field, HelpTip, Modal, ModalBody, ModalFooter } as Record<string, ComponentType<never>>,
    api,
    navigate: (href) => navigateImpl(href),
  };
  window.__elowenRegisterPluginUi = (plugin, registration) => { registrations.set(plugin, registration); };
}

/** Load a plugin's bundle (once) and return its registration. `null` = the script loaded (or failed)
 *  without registering — the caller renders its unavailable placeholder. */
export function loadPluginUi(plugin: string, url: string): Promise<PluginUiRegistration | null> {
  ensurePluginUiRuntime();
  const existing = registrations.get(plugin);
  if (existing) return Promise.resolve(existing);
  const pending = pendingLoads.get(url);
  if (pending) return pending;
  const load = new Promise<PluginUiRegistration | null>((resolveLoad) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = `${BASE}${url}`;
    // A module script executes after load fires; resolve from the registration map either way.
    script.addEventListener('load', () => resolveLoad(registrations.get(plugin) ?? null));
    script.addEventListener('error', () => resolveLoad(null));
    document.head.appendChild(script);
  });
  pendingLoads.set(url, load);
  return load;
}

/** Match `rest` segments against a registration's route patterns: exact segments beat `:param`
 *  captures, longer patterns beat shorter. Returns the component + captured params, or null. */
export function matchPluginPage(
  pages: Record<string, ComponentType<PluginPageProps>> | undefined,
  rest: string[],
): { Component: ComponentType<PluginPageProps>; params: Record<string, string> } | null {
  if (!pages) return null;
  let best: { Component: ComponentType<PluginPageProps>; params: Record<string, string>; exact: number; len: number } | null = null;
  for (const [pattern, Component] of Object.entries(pages)) {
    const parts = pattern === '' ? [] : pattern.split('/');
    if (parts.length !== rest.length) continue;
    const params: Record<string, string> = {};
    let exact = 0;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (part.startsWith(':') && part.length > 1) { params[part.slice(1)] = rest[i]!; continue; }
      if (part !== rest[i]) { ok = false; break; }
      exact += 1;
    }
    if (!ok) continue;
    if (!best || exact > best.exact || (exact === best.exact && parts.length > best.len)) {
      best = { Component, params, exact, len: parts.length };
    }
  }
  return best ? { Component: best.Component, params: best.params } : null;
}
