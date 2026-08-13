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
import { useQueries } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
// The contract (runtime surface, registration shape, Window globals) lives in @elowen/plugin-ui-kit —
// the SAME package plugin authors build against — so the two sides cannot drift. Types ONLY: a value
// import would need Turbopack to resolve the symlinked package outside its root, while `import type`
// is erased before bundling. Re-exported below for the app's own consumers.
import type { PLUGIN_UI_API_VERSION as KIT_API_VERSION, PluginPageProps, PluginUiRegistration } from '@elowen/plugin-ui-kit';
import { BASE, apiErrorMessage, elowenClient, ElowenApiError } from './elowenClient';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Badge } from '../components/ui/Badge';
import { Field } from '../components/ui/Field';
import { HelpTip } from '../components/ui/HelpTip';
import { Modal, ModalBody, ModalFooter } from '../components/ui/Modal';
import { Toggle } from '../components/ui/Toggle';
import { ModuleHeader } from '../components/ui/ModuleHeader';
import { Segmented } from '../components/ui/Segmented';
import { EntityList, EntityRow } from '../components/ui/EntityList';
import { LoadingState, LoadingLine, ErrorState, EmptyState } from '../components/ui/states';
import { MotionLayoutItem, MotionPresence } from '../components/ui/Motion';
import { SpatialWorkspaceLayout, WorkspaceMetric, WorkspacePage, CompactWorkspaceHeader } from '../components/ui/WorkspacePrimitives';
import { ProjectFilterPills } from '../components/ui/ProjectFilterPills';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../components/ui/ControlSurface';
import { ModelIcon } from '../components/ui/ModelIcon';
import { OutcomeBadge } from '../components/ui/OutcomeBadge';
import { ProjectPill } from '../components/ui/ProjectPill';
import { IconButton } from '../components/ui/IconButton';
import { ActionMenu } from '../components/ui/ActionMenu';
import { ContextMenu, DIVIDER } from '../components/ui/ContextMenu';
import { ChangeStrip } from '../components/ui/ChangeStrip';
import { TaskUsageBadge } from '../components/ui/TaskUsageBadge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ManageSelectionModal } from '../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../components/ui/SelectionSummary';
import { BrainModelField } from '../components/ui/BrainModelField';
import { useToast } from '../components/ui/Toast';
import { TerminalModal } from '../components/terminal/TerminalModal';
import { LiveTail } from '../components/terminal/LiveTail';
import { BackendPicker } from '../components/ui/BackendPicker';
import { ProviderPicker } from '../components/ui/ProviderPicker';
import { ModelCatalogField } from '../components/ui/ModelCatalogField';
import { ChoiceField } from '../components/ui/ChoiceField';
import { AutoSaveStatus } from '../components/ui/AutoSaveStatus';
import { Checkbox } from '../components/ui/Checkbox';
import { DataTable, DataTableCell, DataTableRow } from '../components/ui/DataTable';
import { DateRangeFilter } from '../components/ui/DateRangeFilter';
import { ExecutorPicker } from '../components/ui/ExecutorPicker';
import { AgentIdentityStrip } from '../components/ui/AgentIdentityStrip';
import { AgentStatusDot } from '../components/ui/AgentStatusDot';
import { ProgressRibbon } from '../components/ui/ProgressRibbon';
import { PatchView } from '../components/ui/PatchView';
import { ProjectIcon } from '../components/ui/ProjectIcon';
import { TaskContextLine } from '../components/ui/TaskContextLine';
import { Spinner } from '../components/ui/states';
import { MotionLayout } from '../components/ui/Motion';
import { WorkspaceDetailRail } from '../components/ui/WorkspacePrimitives';
import { TONE_TEXT } from '../components/ui/tone';
import { PROVIDERS, ProviderLogo } from '../modules/settings/providers';
import { SettingsDocument, SettingsGroup, SettingsRow } from '../modules/settings/SettingsSurface';
import { MarkdownAssetEditor } from '../modules/settings/MarkdownAssetEditor';
import { allModels } from './execPresets';
import { compactElapsed, parseTs } from './format';
import { isValidSchedule } from './cronSchedule';
import { useAutoSaveStatus } from './useAutoSaveStatus';
import { useMobile } from './useMobile';
import { baseName } from './filePath';
import { copyText } from './clipboard';
import { defineEditorThemes } from './monaco/oledTheme';
import { useTranslation } from './i18n';
import { usePersistentState } from './usePersistentState';
import { useProjectFilter } from './useProjectFilter';
import { useFillHeight } from './useFillHeight';
import {
  useTasks, useConfig, useSessionInfos, useSessionSignals, useSessionSignal,
  useEscalations, usePendingAsks, usePluginUi, useBrainModels, useSystemSkills,
  useCronJobs, useDiscordChannels, usePluginSkills, usePluginSubagents,
  useProjects, useProjectFiles, useProjectFile, useProjectFileAtHead, useProjectCommit,
  useProjectCommitFileDiff, useProjectChanged, useProjectChanges,
  useAllDeps, useMissions, useSessions, useMe, useActivity, useModelUsage, useUsageByDay,
  useProjectsCommits, useTaskConversation, useTaskBrainConversation, useTaskCommits,
  useTaskCommitFileDiff, useMissionNotes, usePlanJob, useAgentsPlugin, useEditorPlugin, useWorkPlugin,
} from './queries';
import {
  useKillSession, useSendInput, useSetTaskStatus, useResumeMission, useApproveGate, useReplyAsk,
  useUpdateConfig, useInstallSkills, useSaveCronJob, useDeleteCronJob,
  useCreatePluginSkill, useUpdatePluginSkill, useDeletePluginSkill,
  useSavePluginSubagent, useDeletePluginSubagent,
  useWriteProjectFile, useNewProjectFile, useNewProjectDir, useRenameProjectEntry, useCopyProjectEntry, useDeleteProjectEntry,
  useCreateTask, useUpdateTask, useDeleteTask, useCloseTask, useSpawn, useSetTaskExec, usePlanTask,
  useInsertPhases, useDeleteMission, useEngage, usePauseMission, useDisengage,
  useOpenMissionPr, useMergeMissionPr, useResetUsage,
} from './mutations';
import {
  needsInputSessions, taskForSession, missionEpicId, keysForOption, agentDisplayName, taskExec,
  taskBlockers, taskSessionName, taskAgentName, taskElapsed, taskElapsedMs, taskStartedMs, phaseDetails,
} from './agentUtils';
import { epicChildren, epicEffectiveStatus, epicLive, epicProgress, phaseIds } from './taskTree';
import {
  DEFAULT_RANGE, inRange, isStoredRange, parseRange, serializeRange, rangeBounds, rangeWindowCapHours,
} from './dateRange';
import { execModel } from './modelProvider';
import { formatTaskTime, formatCost, formatDuration } from './format';
import { fileIcon } from './fileIcon';
import { dirName } from './filePath';
import { openTerminalWindow } from './openTerminalWindow';
import { useSessionStall } from './useSessionStall';
import { useTaskControls } from './useTaskControls';
import { buildUsageSummary } from './usageBars';
import { eventIcon } from './eventMeta';
import { statusTone } from './statusTone';
import { taskTypeMeta } from './taskMeta';

/** Mirrors the kit's constant; the literal-typed annotation keeps the two in lockstep — bumping the
 *  kit without updating this value is a type error, not a silent drift. */
export const PLUGIN_UI_API_VERSION: typeof KIT_API_VERSION = 1;
export type { PluginPageProps, PluginUiRegistration };

/** The page header a plugin surface wears when it is reached as its own page. It is the app's own
 *  workspace header, and the eyebrow is supplied here rather than by each bundle so every plugin page
 *  is labelled the same way in the user's language without shipping the word seven times. A bundle
 *  renders it only for `surface === 'page'`: inside the Settings deck the panel already names the
 *  section, and a second title there would be noise. */
function PluginPageHeader({ title, description, icon, action }: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  return <CompactWorkspaceHeader eyebrow={t.pluginUi.eyebrow} title={title} description={description} icon={icon} action={action} />;
}

/** The frame a plugin's settings section wears per surface, so no bundle has to reimplement it: on a
 *  page it is headed and sits on its own document surface; in the Settings deck the surrounding panel
 *  supplies both, so the children render bare. For a section that already composes its own
 *  SettingsGroups. */
function PluginPageFrame({ surface, title, description, icon, action, plugin, section, children }: {
  surface: 'page' | 'deck';
  /** Omit it and the frame reads the section's label from the manifest listing (already localized), so
   *  the page title has ONE source and cannot drift from the sidebar entry that leads here. */
  title?: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  plugin?: string;
  section?: string;
  children: ReactNode;
}) {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  if (surface === 'deck') return <>{children}</>;
  const entry = plugin === undefined ? undefined : listing.data?.find((p) => p.name === plugin);
  const label = title ?? entry?.settings.find((s) => s.id === section)?.label ?? '';
  return (
    <>
      <PluginPageHeader title={label} description={description} icon={icon} action={action} />
      <SettingsDocument>{children}</SettingsDocument>
    </>
  );
}

/** The common shape: one settings group. In the deck the group carries the section's own title block;
 *  on a page that block becomes the page header instead, because a page that repeats its own name
 *  inside the first card reads like a fragment someone pasted onto an empty screen. */
function PluginSection({ surface, title, description, icon, action, actions, className, density, children }: {
  surface: 'page' | 'deck';
  title: string;
  description?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  actions?: ReactNode;
  className?: string;
  density?: 'comfortable' | 'compact';
  children: ReactNode;
}) {
  const deck = surface === 'deck';
  return (
    <PluginPageFrame surface={surface} title={title} description={description} icon={icon} action={action}>
      <SettingsGroup
        className={className}
        icon={deck ? icon : undefined}
        title={deck ? title : undefined}
        description={deck ? description : undefined}
        actions={actions}
        density={density}
      >
        {children}
      </SettingsGroup>
    </PluginPageFrame>
  );
}

/** Localized view strings for one plugin's bundle: the /plugins/ui listing's merged `strings` record
 *  (manifest English overlaid with the active locale's i18n `web.strings`). Empty while the listing
 *  loads — callers render the empty string, which resolves on the next paint. */
function usePluginStrings(plugin: string): Record<string, string> {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  return listing.data?.find((p) => p.name === plugin)?.strings ?? {};
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

/** Install the window globals exactly once. Idempotent — called from every bundle load, and
 *  exported for tests that render plugin-bundle views against the real runtime surface. */
export function ensurePluginUiRuntime(): void {
  if (typeof window === 'undefined' || window.ElowenUiRuntime) return;
  window.ElowenUiRuntime = {
    apiVersion: PLUGIN_UI_API_VERSION,
    react: React,
    reactDom: ReactDom,
    jsxRuntime: JsxRuntime,
    // Curated: what a plugin page needs to look native. Growing this list is cheap; shrinking it is a
    // breaking change — so every addition is deliberate. The second block is the agents-extraction
    // surface (F3): the workspace/control-surface primitives and terminal views its moved pages compose.
    // The third block is the settings-extraction surface (moved CLI-agents + autopilot sections): the
    // settings document primitives, the model/provider pickers and the autosave indicator.
    components: {
      Button, Input, Badge, Field, HelpTip, Modal, ModalBody, ModalFooter,
      Toggle, ModuleHeader, Segmented, EntityList, EntityRow, LoadingState, LoadingLine, ErrorState, EmptyState,
      MotionLayoutItem, MotionPresence, SpatialWorkspaceLayout, WorkspaceMetric,
      // Page chrome a plugin page needs to look like every built-in workspace, not like a bundle that
      // rebuilt the layout for itself.
      WorkspacePage, CompactWorkspaceHeader, PluginPageHeader, PluginPageFrame, PluginSection, ProjectFilterPills,
      ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar,
      ModelIcon, OutcomeBadge, ProjectPill, IconButton, ActionMenu, ContextMenu, ChangeStrip,
      TaskUsageBadge, ConfirmDialog, TerminalModal, LiveTail,
      SettingsDocument, SettingsGroup, SettingsRow, BackendPicker, ProviderPicker, ModelCatalogField, ChoiceField,
      AutoSaveStatus, ProviderLogo,
      // The moved settings-deck editors' primitives (cronjob's jobs editor and friends).
      ManageSelectionModal, SelectionSummary, BrainModelField, MarkdownAssetEditor,
      // The work-extraction surface (F4): the task/kanban/timeline/stats views compose these. They are
      // app chrome shared with the surfaces that stay (the dashboard renders task shapes too), which is
      // why they live here rather than inside the plugin bundle.
      Checkbox, DataTable, DataTableRow, DataTableCell, DateRangeFilter, ExecutorPicker,
      AgentIdentityStrip, AgentStatusDot, ProgressRibbon, PatchView, ProjectIcon, TaskContextLine,
      Spinner, MotionLayout, WorkspaceDetailRail,
    } as Record<string, ComponentType<never>>,
    // React hooks a plugin page may call (safe across the boundary — the bundle runs on the HOST's
    // React instance). The data hooks keep the react-query cache + SSE signal store in the app, so a
    // plugin page and the core tasks UI share one cache and one invalidation path.
    hooks: {
      useTranslation, useToast, usePersistentState,
      useTasks, useConfig, useSessionInfos, useSessionSignals, useSessionSignal,
      useEscalations, usePendingAsks,
      useKillSession, useSendInput, useSetTaskStatus, useResumeMission, useApproveGate, useReplyAsk,
      useUpdateConfig,
      useBrainModels, useSystemSkills, useInstallSkills, useAutoSaveStatus, usePluginStrings,
      // Cron-job data hooks stay in the core lib (the dashboard's cron tile shares their cache);
      // the cronjob plugin's settings editor reaches them here.
      useCronJobs, useDiscordChannels, useSaveCronJob, useDeleteCronJob,
      usePluginSkills, useCreatePluginSkill, useUpdatePluginSkill, useDeletePluginSkill,
      usePluginSubagents, useSavePluginSubagent, useDeletePluginSubagent,
      // The editor plugin owns the UI and API routes; these host-bound query/mutation hooks retain the
      // shared react-query cache for the project surfaces that link into it.
      useProjects, useProjectFiles, useProjectFile, useProjectFileAtHead, useProjectCommit,
      useProjectCommitFileDiff, useProjectChanged, useProjectChanges,
      useWriteProjectFile, useNewProjectFile, useNewProjectDir, useRenameProjectEntry, useCopyProjectEntry, useDeleteProjectEntry,
      // Layout/selection behaviour shared with the built-in workspaces: the same persisted project
      // filter Tasks and Kanban use, and the same window-measured fill height.
      useMobile, useProjectFilter, useFillHeight,
      // The work plugin owns the task domain (tables, routes, tools, pages) but not a second copy of
      // the browser's data plane: these hooks keep ONE react-query cache and ONE SSE invalidation path,
      // shared with the core surfaces that still read tasks (dashboard tiles, the notification bell).
      useAllDeps, useMissions, useSessions, useMe, useActivity, useModelUsage, useUsageByDay,
      useProjectsCommits, useTaskConversation, useTaskBrainConversation, useTaskCommits,
      // `useWorkPlugin` is here for the same reason the core surfaces use it: a bundle that links to a
      // task page must not offer that link when no plugin serves one (the address would land on the
      // "this plugin is not installed" placeholder).
      useTaskCommitFileDiff, useMissionNotes, usePlanJob, useAgentsPlugin, useEditorPlugin, useWorkPlugin,
      useCreateTask, useUpdateTask, useDeleteTask, useCloseTask, useSpawn, useSetTaskExec, usePlanTask,
      useInsertPhases, useDeleteMission, useEngage, usePauseMission, useDisengage,
      useOpenMissionPr, useMergeMissionPr, useResetUsage,
      useSessionStall, useTaskControls,
      // Batched queries against the host's react-query client: a bundle that imported the library
      // itself would get a second QueryClient context and read an empty cache.
      useQueries,
    },
    // Pure helpers shared with plugin bundles (session/task mapping, formatting, error shaping).
    utils: {
      needsInputSessions, taskForSession, missionEpicId, keysForOption, agentDisplayName, taskExec,
      execModel, formatTaskTime, apiErrorMessage, taskTypeMeta, contextMenuDivider: DIVIDER,
      allModels, cliProviders: PROVIDERS,
      compactElapsed, parseTs, isValidSchedule, baseName, copyText,
      // The Monaco theme is shared, not copied: the host embeds editors of its own (logs, personality,
      // plugin config) and a plugin bundle carrying its own colour table would drift from the UI.
      defineEditorThemes,
      // Task/mission/date/formatting helpers the moved work views compose. `elowenClient` is the app's
      // one HTTP client — a bundle narrows it to the calls it makes rather than shipping a second one.
      taskBlockers, taskSessionName, taskAgentName, taskElapsed, taskElapsedMs, taskStartedMs, phaseDetails,
      epicChildren, epicEffectiveStatus, epicLive, epicProgress, phaseIds,
      DEFAULT_RANGE, inRange, isStoredRange, parseRange, serializeRange, rangeBounds, rangeWindowCapHours,
      formatCost, formatDuration, fileIcon, dirName, openTerminalWindow, statusTone, TONE_TEXT,
      buildUsageSummary, eventIcon, elowenClient, ElowenApiError,
    },
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
