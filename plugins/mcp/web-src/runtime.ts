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
  /** The host's own workspace kit — the same components the built-in pages compose, so this page is
   *  the app's register table and detail drawer rather than a second look-alike of them. */
  components: {
    SpatialWorkspaceLayout: AnyComponent;
    WorkspaceMetric: AnyComponent;
    WorkspaceDetailRail: AnyComponent;
    ControlSurfaceDocument: AnyComponent;
    ControlSurfaceRegister: AnyComponent;
    ControlSurfaceState: AnyComponent;
    ControlSurfaceToolbar: AnyComponent;
    DataTable: AnyComponent;
    DataTableRow: AnyComponent;
    DataTableCell: AnyComponent;
    Segmented: AnyComponent;
    Button: AnyComponent;
    Input: AnyComponent;
    Badge: AnyComponent;
    Field: AnyComponent;
    Toggle: AnyComponent;
    SelectMenu: AnyComponent;
    LoadingState: AnyComponent;
    ErrorState: AnyComponent;
    EmptyState: AnyComponent;
    ConfirmDialog: AnyComponent;
    SelectionSummary: AnyComponent;
    ManageSelectionModal: AnyComponent;
    DetailBlock: AnyComponent;
  };
  hooks: {
    usePluginStrings(plugin: string): Record<string, string>;
    useTranslation(): { t: { common: { close: string }; pluginUi: { eyebrow: string } } };
  };
  utils: {
    /** The daemon's own refusal text when it sent one, rather than a bare status line. */
    apiErrorMessage(error: unknown): string;
  };
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
