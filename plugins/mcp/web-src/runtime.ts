import type { ComponentType, ReactNode } from 'react';

export type McpScope = 'personal' | 'instance';
export type McpTransport = 'stdio' | 'http' | 'sse';

interface McpToolInfo {
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

/** Every icon inside a register is this size, mirroring the host's own `DATA_TABLE_ICON_SIZE`. The
 *  constant is private to the host's DataTable module and the runtime publishes components only, so the
 *  value is restated here rather than imported — a bundle may not compile against `web/`. */
export const DATA_TABLE_ICON_SIZE = 12;

/** One field of the canonical page toolbar's condensed filter control, mirrored from the host's
 *  `PageFilterField` (web/components/ui/PageFilters.tsx) because a bundle may not compile against
 *  `web/` and the runtime publishes components, not their prop types.
 *
 *  The union is the part worth mirroring: the host decides nothing about whether the page is filtered —
 *  it cannot, a control is an opaque node to it — so a field that claims to be active MUST also carry
 *  the chip's wording and the reset behind it. Written out here, forgetting either one is a type error
 *  in this bundle rather than a chip that silently never appears. */
export type PageFilterField = {
  id: string;
  label: string;
  control: ReactNode;
  hint?: string;
} & ({ active: true; activeLabel: string; onReset: () => void } | { active: false });

interface McpRuntime {
  apiVersion: 11;
  /** The host's own workspace kit — the same components the built-in pages compose, so this page is
   *  the app's register table and detail drawer rather than a second look-alike of them. */
  components: {
    WorkspaceShell: AnyComponent;
    WorkspaceMetric: AnyComponent;
    WorkspaceDetailRail: AnyComponent;
    ControlSurfaceDocument: AnyComponent;
    ControlSurfaceRegister: AnyComponent;
    ControlSurfaceState: AnyComponent;
    DataTable: AnyComponent;
    DataTableRow: AnyComponent;
    DataTableCell: AnyComponent;
    DataTableChevronCell: AnyComponent;
    Pager: AnyComponent;
    RegisterSearch: AnyComponent;
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
    useToast(): { toast(message: string, tone?: 'ok' | 'error'): void };
  };
  utils: {
    /** The daemon's own refusal text when it sent one, rather than a bare status line. */
    apiErrorMessage(error: unknown): string;
  };
  api(path: string, init?: RequestInit): Promise<unknown>;
}

interface Registration {
  requiresApiVersion: 11;
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
