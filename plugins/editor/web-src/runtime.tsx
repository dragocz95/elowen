import type { ComponentType } from 'react';

type AnyComponent = ComponentType<any>;
type QueryResult<T> = { data?: T; isLoading: boolean; isError: boolean; refetch(): void };
type MutationResult<T> = {
  mutate(vars: T, callbacks?: { onSuccess?: () => void; onError?: (error: unknown) => void }): void;
  mutateAsync(vars: T): Promise<unknown>;
  isPending: boolean;
};

interface Project { id: number; slug: string; path: string; notes: string; pr_enabled: boolean | null }
export interface FileNode { path: string; type: 'file' | 'dir' }
type Dict = Record<string, Record<string, string>>;

interface EditorRuntime {
  components: Record<string, AnyComponent>;
  hooks: {
    useTranslation(): { t: Dict };
    usePluginStrings(plugin: string): Record<string, string>;
    useToast(): { toast(message: string, tone?: 'ok' | 'error'): void };
    useProjects(): QueryResult<Project[]>;
    useProjectFiles(id: number | null): QueryResult<FileNode[]>;
    useProjectFile(id: number | null, path: string | null): QueryResult<{ content: string; truncated: boolean }>;
    useProjectFileAtHead(id: number | null, path: string | null, enabled: boolean): QueryResult<{ content: string }>;
    useProjectCommit(id: number | null, hash: string | null): QueryResult<{ diff: string; files: string[] }>;
    useProjectCommitFileDiff(id: number | null, hash: string | null, path: string | null): QueryResult<{ diff: string }>;
    useProjectChanged(id: number | null): QueryResult<{ changed: string[] }>;
    useProjectChanges(id: number | null, enabled: boolean): QueryResult<{ diff: string }>;
    useWriteProjectFile(): MutationResult<{ id: number; path: string; content: string }>;
    useNewProjectFile(): MutationResult<{ id: number; path: string }>;
    useNewProjectDir(): MutationResult<{ id: number; path: string }>;
    useRenameProjectEntry(): MutationResult<{ id: number; from: string; to: string }>;
    useCopyProjectEntry(): MutationResult<{ id: number; from: string; to: string }>;
    useDeleteProjectEntry(): MutationResult<{ id: number; path: string }>;
    useMobile(): boolean;
  };
  utils: { baseName(path: string): string; copyText(text: string): Promise<boolean> };
  navigate(href: string): void;
}

type PluginPage = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[] }>;
interface Registration { requiresApiVersion: number; pages: Record<string, PluginPage> }
interface HostWindow { ElowenUiRuntime?: unknown; __elowenRegisterPluginUi?: (name: string, registration: Registration) => void }

export function runtime(): EditorRuntime {
  const value = (window as HostWindow).ElowenUiRuntime as EditorRuntime | undefined;
  if (!value) throw new Error('ElowenUiRuntime is not installed');
  return value;
}

export function registerEditorUi(registration: Registration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('editor', registration);
}

