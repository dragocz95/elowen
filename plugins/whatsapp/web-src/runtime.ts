/** Typed access to the host's window.ElowenUiRuntime for the whatsapp plugin bundle.
 *
 *  The runtime hands over untyped `components`/`hooks` records; this module narrows each entry to
 *  the signature the moved pairing section was written against in the core app. The narrowing is a
 *  local structural CONTRACT, not a source import — the bundle must not compile against `web/`. */
import type { ComponentType } from 'react';

/** Live pairing state read off the running adapter (mirror of the daemon's wire shape). */
export interface WhatsAppPairing { qrImage: string | null; code: string | null; connected: boolean }

// The host components are runtime records; `any` props keep the JSX call sites identical to the
// core original without duplicating every core prop type here (this lean lint set permits it).
type AnyComponent = ComponentType<any>;

interface WhatsAppComponents {
  Button: AnyComponent; Modal: AnyComponent; ModalBody: AnyComponent; ModalFooter: AnyComponent;
  ConfirmDialog: AnyComponent; SettingsGroup: AnyComponent; PluginSection: AnyComponent;
}

interface WhatsAppRuntime {
  components: WhatsAppComponents;
  hooks: { usePluginStrings(plugin: string): Record<string, string> };
  api(path: string, init?: RequestInit): Promise<unknown>;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface WhatsAppRegistration {
  requiresApiVersion: number;
  settings?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: WhatsAppRegistration) => void;
}

/** The host runtime, narrowed. The settings deck loads the bundle only after installing the runtime,
 *  so a missing global here is a programming error worth throwing on. */
export function runtime(): WhatsAppRuntime {
  const rt = (window as HostWindow).ElowenUiRuntime as WhatsAppRuntime | undefined;
  if (!rt) throw new Error('ElowenUiRuntime is not installed');
  return rt;
}

/** Register this plugin's settings components on the host (no-op outside the plugin-UI host page). */
export function registerWhatsAppUi(registration: WhatsAppRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('whatsapp', registration);
}
