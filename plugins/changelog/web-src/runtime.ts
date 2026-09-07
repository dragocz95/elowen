/** The host surface this bundle is allowed to touch, typed by hand.
 *
 *  A plugin bundle may not import the web app (dependency-cruiser enforces it), so the components arrive
 *  at runtime through `window.ElowenUiRuntime`. Props are declared exactly as the host publishes them
 *  rather than as `any`: declaring them loose is how a bundle ships a prop the host never had. */
import type { ComponentType, ReactNode } from 'react';

/** One release, as the listing route reports it. */
export interface EntrySummary {
  version: string;
  date: string;
  title: string;
  tags: string[];
  pinned: boolean;
  unread: boolean;
}
export interface EntryDetail extends EntrySummary {
  /** Raw Markdown, rendered in the browser (see markdown.ts). */
  body: string;
}
export interface EntryListing {
  lastSeenVersion: string | null;
  entries: EntrySummary[];
}

interface QueryResult<T> { data?: T; isLoading: boolean; isError: boolean; error?: unknown; refetch(): void }
interface MutationResult<TVars> { mutate(vars: TVars): void; isPending: boolean }
interface QueryClient { invalidateQueries: (input: { queryKey: unknown[] }) => Promise<void> }

interface RuntimeHooks {
  usePluginStrings(plugin: string): Record<string, string>;
  useQuery<T>(options: Record<string, unknown>): QueryResult<T>;
  useMutation<TVars>(options: Record<string, unknown>): MutationResult<TVars>;
  useQueryClient(): QueryClient;
}

interface RuntimeComponents {
  WorkspaceShell: ComponentType<{
    variant?: 'register' | 'deck' | 'single';
    hero?: { title: string; description?: string; metrics?: ReactNode };
    children: ReactNode;
  }>;
  WorkspaceMetric: ComponentType<{ label: string; value: ReactNode }>;
  Badge: ComponentType<{ children: ReactNode; tone?: 'default' | 'muted' | 'accent' | 'danger' | 'success' | 'warning' }>;
  EmptyState: ComponentType<{ title: string; description?: string }>;
  ErrorState: ComponentType<{ message: string; onRetry?: () => void }>;
  LoadingState: ComponentType<{ variant?: 'list' | 'cards' | 'block'; height?: string }>;
}

interface RuntimeUtils { apiErrorMessage(error: unknown): string; renderMarkdown(text: string): string }

interface ChangelogRuntime {
  components: RuntimeComponents;
  hooks: RuntimeHooks;
  utils: RuntimeUtils;
  api(path: string, init?: RequestInit): Promise<unknown>;
}

interface Registration {
  requiresApiVersion: number;
  pages?: Record<string, ComponentType<{ plugin: string; surface: 'page' | 'deck' }>>;
}

interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: Registration) => void;
}

export const PLUGIN = 'changelog';

/** Same-origin BFF prefix the host's own `api()` helper uses. An `<img>` cannot go through that helper,
 *  so an asset URL is built against the same base. */
export const API_BASE = '/api';

export function runtime(): ChangelogRuntime {
  const value = (window as HostWindow).ElowenUiRuntime as ChangelogRuntime | undefined;
  if (!value) throw new Error('ElowenUiRuntime is not installed');
  return value;
}

export function registerChangelogUi(registration: Registration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.(PLUGIN, registration);
}
