import type { ComponentType } from 'react';

export type McpScope = 'personal' | 'instance';
export type McpTransport = 'stdio' | 'http' | 'sse';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
}

export interface McpServer {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  enabled: boolean;
  status: string;
  toolCount: number;
  tools: McpToolInfo[];
  lastError: string | null;
  reconnecting: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpServersResponse {
  personal: McpServer[];
  instance: McpServer[];
  canManageInstance: boolean;
}

type AnyComponent = ComponentType<any>;
interface McpRuntime {
  components: {
    PluginPageHeader: AnyComponent;
    SettingsDocument: AnyComponent;
    SettingsGroup: AnyComponent;
    SettingsRow: AnyComponent;
    Button: AnyComponent;
    Input: AnyComponent;
    Badge: AnyComponent;
    Field: AnyComponent;
    HelpTip: AnyComponent;
    Modal: AnyComponent;
    ModalBody: AnyComponent;
    ModalFooter: AnyComponent;
    Toggle: AnyComponent;
    SelectMenu: AnyComponent;
    LoadingState: AnyComponent;
    ErrorState: AnyComponent;
    EmptyState: AnyComponent;
    ConfirmDialog: AnyComponent;
    ManageSelectionModal: AnyComponent;
    SelectionSummary: AnyComponent;
  };
  hooks: { usePluginStrings(plugin: string): Record<string, string> };
  api(path: string, init?: RequestInit): Promise<unknown>;
}

interface Registration {
  requiresApiVersion: number;
  pages: Record<string, ComponentType<{ surface: 'page' | 'deck' }>>;
}

interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: Registration) => void;
}

export function runtime(): McpRuntime {
  const value = (window as HostWindow).ElowenUiRuntime as McpRuntime | undefined;
  if (!value) throw new Error('ElowenUiRuntime is not installed');
  return value;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  return await runtime().api(path, init) as T;
}

export function registerMcpUi(registration: Registration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('mcp', registration);
}
