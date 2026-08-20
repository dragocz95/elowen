import type { ComponentType } from 'react';

export interface TeamsIdentityUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

export interface TeamsIdentity {
  linked: boolean;
  user?: TeamsIdentityUser;
  linkedAt?: string;
}

export interface TeamsPerson {
  key: string;
  name: string;
  upn: string;
  aadObjectId: string;
  teamsId: string;
  teamsAvatarUrl?: string;
  hasPersonalChat: boolean;
  lastSeenAt: number | null;
  identity?: TeamsIdentity;
}

export interface TeamsAccountProfile {
  id: string;
  displayName: string;
  userPrincipalName: string;
  mail: string;
  accountEnabled: boolean;
  userType: string;
}

export interface TeamsAccountDetail extends TeamsIdentity {
  signedIn: boolean;
  verifiedAt?: string;
  profile?: TeamsAccountProfile;
}

export interface PeopleResponse {
  active: boolean;
  people: TeamsPerson[];
}

export interface RolePolicy {
  roleId: string;
  name: string;
  projectIds: number[];
  prompt?: string;
  tools?: string[];
  admin?: boolean;
  elowenUser?: string;
  [key: string]: unknown;
}

export interface ConfigField {
  key: string;
  label: string;
  hint?: string;
  type: string;
  options?: { value: string; label: string }[];
  risk?: 'low' | 'medium' | 'high';
  [key: string]: unknown;
}

export interface PluginDetail {
  name: string;
  config: Record<string, unknown>;
  configSchema: ConfigField[];
  secretsSet: string[];
  i18n?: Record<string, { fields?: Record<string, { label?: string; hint?: string; options?: Record<string, string> }> }>;
}

interface QueryResult<T> {
  data?: T;
  isLoading: boolean;
  isError: boolean;
  refetch(): void;
}

export interface User { id: number; username: string; name?: string; avatar?: string }
interface Project { id: number; slug: string; name?: string }
interface PluginInfo { name: string; enabled: boolean; hasIcon?: boolean; provides: { tools?: string[] } }
interface ConfigDraft {
  values: Record<string, unknown>;
  setValue(key: string, value: unknown): void;
  status: 'idle' | 'saving' | 'saved' | 'error';
  retry(): void;
  flush(): void;
  ready: boolean;
}

interface TeamsHooks {
  usePluginStrings(plugin: string): Record<string, string>;
  useTranslation(): { locale: string };
  usePluginDetail(plugin: string): QueryResult<PluginDetail>;
  usePluginConfigDraft(plugin: string, detail: Pick<PluginDetail, 'config' | 'configSchema'>): ConfigDraft;
  useUsers(): QueryResult<User[]>;
  useProjects(): QueryResult<Project[]>;
  usePlugins(): QueryResult<PluginInfo[]>;
}

type AnyComponent = ComponentType<any>;
interface TeamsComponents {
  SpatialWorkspaceLayout: AnyComponent;
  WorkspaceMetric: AnyComponent;
  ControlSurfaceDocument: AnyComponent;
  ControlSurfaceToolbar: AnyComponent;
  ControlSurfaceRegister: AnyComponent;
  ControlSurfaceState: AnyComponent;
  SettingsDocument: AnyComponent;
  SettingsGroup: AnyComponent;
  PluginConfigEditor: AnyComponent;
  AutoSaveStatus: AnyComponent;
  LoadingState: AnyComponent;
  ErrorState: AnyComponent;
  EmptyState: AnyComponent;
  ConfirmDialog: AnyComponent;
  Button: AnyComponent;
  Input: AnyComponent;
  Avatar: AnyComponent;
  Badge: AnyComponent;
  Field: AnyComponent;
  Toggle: AnyComponent;
  SelectMenu: AnyComponent;
  Checkbox: AnyComponent;
  ManageSelectionModal: AnyComponent;
  SelectionSummary: AnyComponent;
}

interface TeamsRuntime {
  components: TeamsComponents;
  hooks: TeamsHooks;
  utils: { apiErrorMessage(error: unknown): string };
  api(path: string, init?: RequestInit): Promise<unknown>;
}

type PluginPageComponent = ComponentType<{ plugin: string; params: Record<string, string>; rest: string[]; surface: 'page' | 'deck' }>;
interface TeamsRegistration {
  requiresApiVersion: number;
  pages?: Record<string, PluginPageComponent>;
}
interface HostWindow {
  ElowenUiRuntime?: unknown;
  __elowenRegisterPluginUi?: (plugin: string, registration: TeamsRegistration) => void;
}

export function runtime(): TeamsRuntime {
  const value = (window as HostWindow).ElowenUiRuntime as TeamsRuntime | undefined;
  if (!value) throw new Error('ElowenUiRuntime is not installed');
  return value;
}

export function registerTeamsUi(registration: TeamsRegistration): void {
  (window as HostWindow).__elowenRegisterPluginUi?.('msteams', registration);
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  return await runtime().api(path, init) as T;
}
