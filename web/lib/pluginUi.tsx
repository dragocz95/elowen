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
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
// The contract (runtime surface, registration shape, Window globals) lives in elowen-plugin-ui-kit —
// the SAME package plugin authors build against — so the two sides cannot drift. Types ONLY: a value
// import would need Turbopack to resolve the symlinked package outside its root, while `import type`
// is erased before bundling. Re-exported below for the app's own consumers.
import type { PLUGIN_UI_API_VERSION as KIT_API_VERSION, PluginPageProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { BASE, apiErrorMessage, elowenClient, ElowenApiError } from './elowenClient';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Slider } from '../components/ui/Slider';
import { Avatar as UserAvatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Field } from '../components/ui/Field';
import { HelpTip } from '../components/ui/HelpTip';
import { Modal, ModalBody, ModalFooter } from '../components/ui/Modal';
import { Toggle } from '../components/ui/Toggle';
import { ModuleHeader } from '../components/ui/ModuleHeader';
import { Segmented } from '../components/ui/Segmented';
import { SelectMenu } from '../components/ui/SelectMenu';
import { EntityList, EntityRow } from '../components/ui/EntityList';
import { LoadingState, LoadingLine, ErrorState, EmptyState } from '../components/ui/states';
import { MotionLayoutItem, MotionPresence } from '../components/ui/Motion';
import { SpatialWorkspaceLayout, WorkspaceMetric, WorkspacePage, CompactWorkspaceHeader } from '../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../components/ui/WorkspaceShell';
import { WorkspaceHero } from '../components/ui/WorkspaceHero';
import { WorkspaceTakeover } from '../components/ui/WorkspaceTakeover';
import { Pager } from '../components/ui/Pager';
import { PageToolbar } from '../components/ui/PageToolbar';
import { PageFilters } from '../components/ui/PageFilters';
import { RegisterSearch } from '../components/ui/RegisterSearch';
import { SpatialIdentity } from '../components/ui/SpatialPrimitives';
import { TimeSeriesChart } from '../components/ui/TimeSeriesChart';
import { ProjectFilterPills } from '../components/ui/ProjectFilterPills';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar } from '../components/ui/ControlSurface';
import { ModelIcon } from '../components/ui/ModelIcon';
import { OutcomeBadge } from '../components/ui/OutcomeBadge';
import { ProjectPill } from '../components/ui/ProjectPill';
import { IconButton } from '../components/ui/IconButton';
import { ActionMenu } from '../components/ui/ActionMenu';
import { ContextMenu, DIVIDER } from '../components/ui/ContextMenu';
import { ChangeStrip } from '../components/ui/ChangeStrip';
import { ProgressRibbon } from '../components/ui/ProgressRibbon';
import { PatchView } from '../components/ui/PatchView';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ManageSelectionModal } from '../components/ui/ManageSelectionModal';
import { SelectionSummary, SummaryChip } from '../components/ui/SelectionSummary';
import { LinkedAccountRow } from '../components/ui/LinkedAccountRow';
import { DetailBlock } from '../components/ui/DetailBlock';
import { BrainModelField } from '../components/ui/BrainModelField';
import { useToast } from '../components/ui/Toast';
import { LiveTail } from '../components/terminal/LiveTail';
import { BackendPicker } from '../components/ui/BackendPicker';
import { ProviderPicker } from '../components/ui/ProviderPicker';
import { ModelCatalogField } from '../components/ui/ModelCatalogField';
import { ChoiceField } from '../components/ui/ChoiceField';
import { AutoSaveStatus } from '../components/ui/AutoSaveStatus';
import { Checkbox } from '../components/ui/Checkbox';
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../components/ui/DataTable';
import { DateRangeFilter } from '../components/ui/DateRangeFilter';
import { ExecutorPicker } from '../components/ui/ExecutorPicker';
import { Spinner } from '../components/ui/states';
import { MotionLayout } from '../components/ui/Motion';
import { WorkspaceDetailRail } from '../components/ui/WorkspacePrimitives';
import { PROVIDERS, ProviderLogo } from '../modules/settings/providers';
import { SettingsDocument, SettingsGroup, SettingsRow } from '../components/ui/SettingsSurface';
import { PluginConfigEditor } from '../modules/settings/PluginConfigEditor';
import { usePluginConfigDraft } from './usePluginConfigDraft';
import { MarkdownAssetEditor } from '../modules/settings/MarkdownAssetEditor';
import { allModels } from './execPresets';
import { compactElapsed, parseTs } from './format';
import { isValidSchedule } from './cronSchedule';
import { useAutoSaveStatus } from './useAutoSaveStatus';
import { useMobile } from './useMobile';
import { baseName } from './filePath';
import { copyText } from './clipboard';
import { defineEditorThemes, editorTheme } from './monaco/oledTheme';
import { useTranslation } from './i18n';
import { usePersistentState } from './usePersistentState';
import { useProjectFilter } from './useProjectFilter';
import { useFillHeight } from './useFillHeight';
import {
  useConfig, usePluginUi, useBrainModels, useUsers, usePlugins,
  useCronJobs, useNotificationDestinations, usePluginSkills, usePluginSubagents, usePluginDetail,
  useProjects, useProjectFiles, useProjectFile, useProjectFileAtHead, useProjectCommit,
  useProjectCommitFileDiff, useProjectChanged, useProjectChanges,
  useMe, useActivity, useModelUsage, useUsageByDay, useUsageByOrigin,
} from './queries';
import {
  useUpdateConfig, useSaveCronJob, useDeleteCronJob,
  useCreatePluginSkill, useUpdatePluginSkill, useDeletePluginSkill,
  useSavePluginSubagent, useDeletePluginSubagent, useSavePluginConfig,
  useWriteProjectFile, useNewProjectFile, useNewProjectDir, useRenameProjectEntry, useCopyProjectEntry, useDeleteProjectEntry,
  useResetUsage,
} from './mutations';
import { formatCost, formatDuration } from './format';
import { fileIcon } from './fileIcon';
import { dirName } from './filePath';
import { buildUsageSummary } from './usageBars';
import { DEFAULT_RANGE, isStoredRange, parseRange, rangeBounds, serializeRange } from './dateRange';
import { eventIcon } from './eventMeta';

// @platform-keep plugin-ui-runtime :: window.ElowenUiRuntime && PLUGIN_UI_API_VERSION
/** Generic browser-plugin platform for future github/sandblox consumers; zero in-repo callers is expected.
 *
 * Mirrors the kit's constant; the literal-typed annotation keeps the two in lockstep — bumping the
 *  kit without updating this value is a type error, not a silent drift. */
export const PLUGIN_UI_API_VERSION: typeof KIT_API_VERSION = 10;
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

/** The common shape: one settings group. The section's own name never appears INSIDE the card. On a page
 *  it is the page header; in the account deck the section rail already carries both the label and the
 *  description, from the very same manifest entry. A native account section renders no card title
 *  either, so a plugin that repeated its own name was the one panel on the page wearing a second
 *  heading. */
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
  return (
    <PluginPageFrame surface={surface} title={title} description={description} icon={icon} action={action}>
      <SettingsGroup className={className} actions={actions} density={density}>
        {children}
      </SettingsGroup>
    </PluginPageFrame>
  );
}

/** Localized view strings for one plugin's bundle: the /plugins/ui listing's merged `strings` record
 *  (manifest English overlaid with the active locale's i18n `web.strings`).
 *
 *  TOTAL by construction: an unknown key reads as the empty string rather than `undefined`. The record
 *  is empty for the paint or two before the listing resolves, and a view that formats its copy
 *  (`s.someKey.replace('{n}', …)`) would not render a blank label there — it would throw and take the
 *  whole page down over a string that was one round-trip away. Rendering nothing for that instant is
 *  the only sane behaviour.
 *
 *  This is deliberately NOT the place that catches a missing key: a typo or a renamed manifest entry
 *  is caught statically by `tests/contract/pluginBundleStringKeys.test.ts` (the key a bundle reads must
 *  exist in its manifest) and by `scripts/check-languages.mjs` (every manifest key is translated in
 *  every locale). Crashing at runtime would not find them any earlier — it would only find them in
 *  front of a user. */
function usePluginStrings(plugin: string): Record<string, string> {
  const { locale } = useTranslation();
  const listing = usePluginUi(locale);
  const strings = listing.data?.find((p) => p.name === plugin)?.strings;
  return React.useMemo(() => new Proxy(strings ?? {}, {
    get: (target, key) => (typeof key === 'string' ? target[key] ?? '' : undefined),
  }), [strings]);
}

/** Same-origin JSON fetch against the daemon through the BFF (`/api` + path). Rejects on non-2xx with
 *  an ElowenApiError carrying the daemon's own `error` string, so a plugin passing the rejection to
 *  `utils.apiErrorMessage` shows what the route actually refused rather than a bare status line. */
async function api(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { ...init, credentials: 'same-origin' });
  if (!res.ok) {
    let body: Record<string, unknown> | undefined;
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON body */ }
    const code = typeof body?.error === 'string' ? body.error : undefined;
    throw new ElowenApiError(`api ${res.status} on ${path}`, res.status, code, body);
  }
  return res.status === 204 ? undefined : res.json();
}

type PluginAvatarProps = {
  name?: string;
  src?: string;
  user?: { id: number; username: string; name?: string; avatar?: string };
  size?: number | 'sm' | 'md' | 'lg';
};

/** Public plugin avatar contract. A plugin-owned image wins, then the linked Elowen account avatar,
 * then initials. The host's account Avatar stays behind this adapter so directory-only people never
 * have to mimic its internal user shape. */
function PluginAvatar({ name, src, user, size = 'md' }: PluginAvatarProps) {
  const [sourceFailed, setSourceFailed] = React.useState(false);
  React.useEffect(() => setSourceFailed(false), [src]);
  const pixels = typeof size === 'number' ? size : size === 'sm' ? 28 : size === 'lg' ? 44 : 36;
  const label = name?.trim() || user?.name?.trim() || user?.username || '?';
  if (src && !sourceFailed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={label}
        className="shrink-0 rounded-full border border-border object-cover"
        style={{ width: pixels, height: pixels }}
        onError={() => setSourceFailed(true)}
      />
    );
  }
  return <UserAvatar user={user ?? { id: 0, username: label, name: label }} size={pixels} />;
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
    // @platform-keep plugin-ui-primitives :: DataTable, DataTableRow, DataTableCell && PatchView && ProgressRibbon && LiveTail && WorkspaceShell, WorkspaceHero && Pager, RegisterSearch, DataTableChevronCell && WorkspaceTakeover
    // Generic UI platform for future github/sandblox bundles; zero callers for any one primitive is expected.
    // Growing this list is cheap; shrinking it is a breaking change.
    // `ConstellationScope` left with the orbital settings rendering it existed to switch on, and
    // `TerminalModal` + the `openTerminalWindow` helper left with the browser terminal they opened. The
    // API version deliberately did NOT move for any of them: no bundle in this repo, the registry or the
    // Chetty fork ever named one, so nothing a released plugin can ask for changed. Withdrawing a
    // primitive some bundle DOES reference has to bump the version instead — though note the version is
    // a compatibility CEILING (`entry.apiVersion <= host`), so it can announce an ADDITION and cannot
    // express a removal at all; that is exactly why a referenced primitive must not be withdrawn.
    components: {
      Button, Input, Slider, Avatar: PluginAvatar, Badge, Field, HelpTip, Modal, ModalBody, ModalFooter,
      Toggle, ModuleHeader, Segmented, SelectMenu, EntityList, EntityRow, LoadingState, LoadingLine, ErrorState, EmptyState,
      MotionLayoutItem, MotionPresence, SpatialWorkspaceLayout, WorkspaceMetric,
      // Page chrome a plugin page needs to look like every built-in workspace, not like a bundle that
      // rebuilt the layout for itself.
      WorkspacePage, CompactWorkspaceHeader, PluginPageHeader, PluginPageFrame, PluginSection, ProjectFilterPills,
      ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState, ControlSurfaceToolbar,
      ModelIcon, OutcomeBadge, ProjectPill, IconButton, ActionMenu, ContextMenu, ChangeStrip,
      ConfirmDialog, LiveTail,
      SettingsDocument, SettingsGroup, SettingsRow, SpatialIdentity, TimeSeriesChart, PluginConfigEditor, BackendPicker, ProviderPicker, ModelCatalogField, ChoiceField,
      AutoSaveStatus, ProviderLogo,
      // The moved settings-deck editors' primitives (cronjob's jobs editor and friends). DetailBlock is
      // the caption+hint wrapper the user detail puts above each of these summaries, shared so a plugin
      // showing a managed selection reads as the same thing rather than an approximation of it.
      ManageSelectionModal, SelectionSummary, DetailBlock, BrainModelField, MarkdownAssetEditor,
      // A connector identity, shaped like the chat platforms it sits between. Both are here so a plugin
      // cannot approximate either one: the drawer row it hangs in and the chip it contributes to the
      // closed summary are the SAME components the host draws for Discord and friends, so "looks the
      // same" is a fact about the code rather than a resemblance someone has to maintain by eye.
      LinkedAccountRow, SummaryChip,
      Checkbox, DataTable, DataTableRow, DataTableCell, DateRangeFilter, ExecutorPicker,
      ProgressRibbon, PatchView, Spinner, MotionLayout, WorkspaceDetailRail,
      // The canonical page shell, published so a bundle stops reaching for the SpatialWorkspaceLayout
      // alias: the alias only ever built a `register` page, so a plugin whose surface is a settings deck
      // or a single working pane had to approximate the other two variants out of raw markup.
      WorkspaceShell, WorkspaceHero,
      // The full-application takeover a plugin page occupies when its surface IS the whole screen (the
      // editor's fullscreen mode). Published because every hand-rolled version got the same three things
      // wrong — `vh` sizing, a literal z-index in the middle of the overlay scale, and an unlabelled
      // 28px chevron as the only exit — and a bundle cannot reach the overlay machinery any other way.
      WorkspaceTakeover,
      // The register footer, the register toolbar's search field and the row's trailing open affordance —
      // the three pieces every plugin register hand-rolled. Five bundles (mcp, cronjob, stats, onedrive,
      // editor) each carried their own pager, and the search field was copy-pasted with a hard `min-w`
      // that pushed its sibling controls out of a narrow toolbar.
      Pager, RegisterSearch, DataTableChevronCell,
      // The canonical page toolbar and its condensed filter control. A bundle normally reaches the row
      // through `WorkspaceShell`'s `toolbar` prop — that is what puts a plugin register's search and
      // filters in the same place as every built-in page — but both are published as components too, so
      // a surface that mounts its own shell (or none) can still draw the canonical row rather than the
      // hand-rolled band each register used to carry.
      PageToolbar, PageFilters,
    } as Record<string, ComponentType<never>>,
    // React hooks a plugin page may call (safe across the boundary — the bundle runs on the HOST's
    // React instance). The data hooks keep the react-query cache + SSE signal store in the app, so a
    // plugin pages and core surfaces share one cache and one invalidation path.
    hooks: {
      useTranslation, useToast, usePersistentState,
      useConfig, useUpdateConfig,
      useBrainModels, useAutoSaveStatus, usePluginStrings,
      useUsers, usePlugins, usePluginConfigDraft,
      useCronJobs, useNotificationDestinations, useSaveCronJob, useDeleteCronJob,
      usePluginDetail, useSavePluginConfig,
      usePluginSkills, useCreatePluginSkill, useUpdatePluginSkill, useDeletePluginSkill,
      usePluginSubagents, useSavePluginSubagent, useDeletePluginSubagent,
      useProjects, useProjectFiles, useProjectFile, useProjectFileAtHead, useProjectCommit,
      useProjectCommitFileDiff, useProjectChanged, useProjectChanges,
      useWriteProjectFile, useNewProjectFile, useNewProjectDir, useRenameProjectEntry, useCopyProjectEntry, useDeleteProjectEntry,
      useMobile, useProjectFilter, useFillHeight,
      useMe, useActivity, useModelUsage, useUsageByDay, useUsageByOrigin, useResetUsage,
      // Raw React Query hooks against the host's one QueryClient. A bundle importing the library itself
      // would get a second context and an empty cache, so every query/mutation/infinite-query path crosses
      // this runtime surface instead.
      useQuery, useMutation, useInfiniteQuery, useQueries, useQueryClient,
    },
    // Pure helpers shared with plugin bundles (formatting, navigation and error shaping).
    utils: {
      apiErrorMessage, contextMenuDivider: DIVIDER,
      allModels, cliProviders: PROVIDERS,
      compactElapsed, parseTs, isValidSchedule, baseName, copyText,
      defineEditorThemes, editorTheme,
      formatCost, formatDuration, fileIcon, dirName,
      buildUsageSummary, eventIcon, elowenClient, ElowenApiError,
      // The date-range helpers a usage page needs to persist and read back its own filter. They were
      // added here for the retired `work` views and removed with them, but `stats` reads the same five
      // — so its page threw "serializeRange is not a function" on mount from then on.
      DEFAULT_RANGE, isStoredRange, parseRange, rangeBounds, serializeRange,
    },
    api,
    navigate: (href) => navigateImpl(href),
  };
  window.__elowenRegisterPluginUi = (plugin, registration) => { registrations.set(plugin, registration); };
}

/** Link a plugin's own stylesheet into the document, once per URL, and resolve when the browser has
 *  APPLIED it. The app is shipped prebuilt, so its CSS carries only the utilities the host itself uses;
 *  anything else a plugin's markup asks for exists only in this sheet. Insert before the host stylesheet:
 *  older plugins were built into the shared `utilities` layer, and appending one after the host let generic
 *  classes such as grid/flex utilities corrupt every page visited afterwards until reload. New builds use a
 *  dedicated lower layer too, but DOM order keeps already-installed plugin versions safe. An `error` resolves
 *  so a missing sheet degrades to an unstyled page rather than a page that never renders. */
const pendingCss = new Map<string, Promise<void>>();
function ensurePluginCss(cssUrl: string): Promise<void> {
  const href = `${BASE}${cssUrl}`;
  const pending = pendingCss.get(href);
  if (pending) return pending;
  const load = new Promise<void>((done) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.addEventListener('load', () => done());
    link.addEventListener('error', () => done());
    const hostStyle = document.head.querySelector<HTMLLinkElement | HTMLStyleElement>('link[rel="stylesheet"], style');
    // The shell normally has host CSS by the time a plugin can mount. During early hydration/HMR it may not;
    // placing the link first still keeps it ahead of host styles that Next appends afterwards.
    document.head.insertBefore(link, hostStyle ?? document.head.firstChild);
  });
  pendingCss.set(href, load);
  return load;
}

/** Load a plugin's bundle (once) and return its registration. `null` = the script loaded (or failed)
 *  without registering — the caller renders its unavailable placeholder.
 *
 *  This is the ONLY place a plugin bundle is loaded, so it is also the only place its stylesheet can be
 *  linked. The returned promise waits for BOTH: the caller renders nothing until it settles, and a page
 *  painted before its stylesheet applied is a visible flash of unstyled plugin. */
export function loadPluginUi(plugin: string, url: string, cssUrl?: string): Promise<PluginUiRegistration | null> {
  ensurePluginUiRuntime();
  // Keyed by bundle URL and checked BEFORE the registration map: a bundle registers synchronously as it
  // executes, so an already-registered plugin whose sheet is still in flight must keep waiting here.
  const pending = pendingLoads.get(url);
  if (pending) return pending;
  const existing = registrations.get(plugin);
  if (existing) return Promise.resolve(existing);
  // Started first so the sheet downloads in parallel with the bundle, not after it.
  const css = cssUrl ? ensurePluginCss(cssUrl) : Promise.resolve();
  const script = new Promise<PluginUiRegistration | null>((resolveLoad) => {
    const el = document.createElement('script');
    el.type = 'module';
    el.src = `${BASE}${url}`;
    // A module script executes after load fires; resolve from the registration map either way.
    el.addEventListener('load', () => resolveLoad(registrations.get(plugin) ?? null));
    el.addEventListener('error', () => resolveLoad(null));
    document.head.appendChild(el);
  });
  const load = Promise.all([script, css]).then(([registration]) => registration);
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
