'use client';
export const dynamic = 'force-dynamic';
// Aliased: `dynamic` is already this route's Next segment-config export, two lines up.
import nextDynamic from 'next/dynamic';
import { Activity, useCallback, useEffect, useState, useRef, type ReactNode } from 'react';
import { SlidersHorizontal, Gauge, LayoutDashboard, Lock, RefreshCw, RotateCcw, Sparkles, KeyRound, Boxes, Blocks, HardDrive, Server, CalendarClock, ScrollText, BellRing, MessageSquareText, MemoryStick, Timer, ToggleRight } from 'lucide-react';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { groupBrainModelsByProvider } from '../../components/ui/brainModelSelection';
import { ContextWindowModal } from '../../modules/settings/ContextWindowModal';
import { PluginsSection } from '../../modules/settings/PluginsSection';
import { BrainSection } from '../../modules/settings/BrainSection';
import { ModelRolesSection } from '../../modules/settings/ModelRolesSection';
import { DashboardSection } from '../../modules/settings/DashboardSection';
import { formatTokens } from '../../lib/format';
import { useBrainModels, useConfig, useMe, usePluginUi, useSystem, useLogFiles } from '../../lib/queries';
import { useBrand } from '../../lib/brand';
import { LogsModal } from '../../modules/settings/LogsModal';
import { ConversationDiagnosticsModal } from '../../modules/settings/ConversationDiagnosticsModal';
import { formatBytes } from '../../lib/format';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback, type SaveFeedback } from '../../lib/saveFeedback';
import { useUpdateConfig, useSystemUpdate, useSystemRestart } from '../../lib/mutations';
import { usePersistentState } from '../../lib/usePersistentState';
import { useRouter, useSearchParams } from 'next/navigation';
import { SECTION_ALIASES, SETTINGS_CATEGORY_VALUES, SETTINGS_SECTIONS, type SettingsCategory } from '../../modules/settings/categories';
import { isPluginSettingsSectionId, parsePluginSettingsSectionId } from '../../modules/settings/pluginSections';
import { pluginSectionHref } from '../../lib/pluginNav';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../lib/elowenClient';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { WorkspaceLeadScope, WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { type PageToolbarProps } from '../../components/ui/PageToolbar';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { WorkspaceMetric, type WorkspaceHeroProps } from '../../components/ui/WorkspaceHero';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { SettingsDocument, SettingsGroup, SettingsRow, SettingsState } from '../../components/ui/SettingsSurface';
import { SkinsRow } from '../../modules/settings/SkinsRow';
import { DaysPolicyEditor } from '../../modules/settings/DaysPolicyEditor';
import { MotionReveal } from '../../components/ui/Motion';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { interpolate, useTranslation } from '../../lib/i18n';
import { rowAnchor } from '../../lib/rowAnchors';
import { useRowAnchor } from '../../lib/useRowAnchor';

/** Loaded on demand: the dials pull in the charting library, and Settings is a heavy page where most
 *  visits never scroll to the System section. `ssr: false` because the dials measure their own box,
 *  which is zero on the server. The placeholder reserves the drawn height so the page does not jump. */
const SystemDiagnostics = nextDynamic(
  () => import('../../modules/settings/SystemDiagnostics').then((m) => m.SystemDiagnostics),
  { ssr: false, loading: () => <LoadingState variant="block" height="h-[150px]" /> },
);

function formatMemory(used: number, total: number): string {
  const gb = (value: number) => `${(value / 1_000_000_000).toFixed(1)} GB`;
  return `${gb(used)} / ${gb(total)}`;
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

const CATEGORY_VALUES = SETTINGS_CATEGORY_VALUES;
type Category = SettingsCategory;

const TOKEN_TTL_PRESETS = [7, 30, 90, 365] as const;
const SESSION_RETENTION_PRESETS = [7, 10, 30, 90] as const;

/** A deck section id: a core category, or a plugin-contributed `plugin:<name>:<id>` section. Stored
 *  state validates by SHAPE (the plugin listing loads asynchronously); the listing then confirms a
 *  plugin section still exists and falls back to `system` when its plugin was disabled. */
const isSectionId = (value: string): boolean =>
  (CATEGORY_VALUES as readonly string[]).includes(value) || isPluginSettingsSectionId(value);

/** Resolve a retired section id to its successor BEFORE anything judges its validity — otherwise an old
 *  `?cat=memory` link would fail the check and land the reader on System instead of on the page its
 *  content actually moved to. Anything with no successor is returned untouched, so `isSectionId`'s own
 *  fallback still catches a genuinely unknown id. */
const resolveSectionId = (value: string): string => SECTION_ALIASES[value] ?? value;

/** Categories rendered as an orbital constellation (rows become pods, composites edit in drawers,
 *  the document card frame drops). The rest — catalogs, lists and data views — stay classic. */
const ORBITAL_CATEGORIES: ReadonlySet<string> = new Set<Category>(['system', 'brain']);

/** Keep a settings document alive after its first visit without eagerly mounting every category's
 *  data hooks. React Activity retains form/search state and pauses effects while a panel is hidden. */
function SettingsPanel({ id, active, visited, children }: {
  id: string;
  active: string;
  visited: ReadonlySet<string>;
  children: ReactNode;
}) {
  if (id !== active && !visited.has(id)) return null;
  return (
    <WorkspaceLeadScope active={id === active}>
      <Activity mode={id === active ? 'visible' : 'hidden'}>
        <MotionReveal data-settings-panel={id} data-constellation={ORBITAL_CATEGORIES.has(id) ? '' : undefined}>
          <SettingsDocument>{children}</SettingsDocument>
        </MotionReveal>
      </Activity>
    </WorkspaceLeadScope>
  );
}

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const system = useSystem();
  const systemUpdate = useSystemUpdate();
  const systemRestart = useSystemRestart();
  const me = useMe();
  const brand = useBrand();
  const brainModels = useBrainModels();
  const { toast } = useToast();
  const { t, locale } = useTranslation();
  const agentAiLabel = interpolate(t.settings.brain, { agentName: brand.agentName });
  // Plugin-contributed Settings sections ride the same live listing as the sidebar's plugin worlds:
  // toggling a plugin invalidates the query and its sections appear/disappear without a reload.
  const pluginUi = usePluginUi(locale);
  // Whether the log viewer is open (Data section). Mounted only while open, so its queries stay idle
  // until someone actually asks to read the logs.
  const [logsOpen, setLogsOpen] = useState(false);
  const [conversationDiagnosticsOpen, setConversationDiagnosticsOpen] = useState(false);
  // Which service the "restart?" confirm dialog is asking about (null = closed).
  const [restartTarget, setRestartTarget] = useState<'daemon' | 'web' | null>(null);

  // Active section — a real state (remembered in localStorage across F5) kept in step with the URL
  // `?cat=<section>`. Switching flips the state directly (so the view changes instantly) AND rewrites
  // the URL (so F5 / share / the sidebar highlight agree).
  const searchParams = useSearchParams();
  const router = useRouter();
  // Both the stored value and the URL are resolved through the alias table first, so a bookmark or a
  // remembered `memory` reaches Models rather than failing the validity check and dropping to System.
  const [storedCategory, setStoredCategory] = usePersistentState<string>('elowen.settings.category', 'system', (v) => isSectionId(resolveSectionId(v)));
  const category = resolveSectionId(storedCategory);
  const setCategoryState = useCallback((next: string) => setStoredCategory(resolveSectionId(next)), [setStoredCategory]);
  const [visitedCategories, setVisitedCategories] = useState<Set<string>>(() => new Set([category]));
  // Keyed by DECK SECTION id, not by core category: a plugin-contributed section renders inside this
  // same deck, and an orbital one has no header of its own an autosave indicator could live in.
  const [sectionFeedback, setSectionFeedback] = useState<Partial<Record<string, SaveFeedback>>>({});
  const reportSaveState = useCallback((id: string, status: SaveStatus, retry?: () => void) => {
    if (!isSectionId(id)) return;
    setSectionFeedback((current) => ({ ...current, [id]: { status, retry } }));
  }, []);
  useEffect(() => {
    setVisitedCategories((current) => current.has(category) ? current : new Set(current).add(category));
  }, [category]);
  // Only while the Data section is on screen — the log summary is a nicety, not a reason to query the
  // daemon from every other settings tab.
  const logFiles = useLogFiles(category === 'data');
  const isValidCat = (c: string | null): c is string => !!c && isSectionId(resolveSectionId(c));
  // Settings is core-only: a plugin's settings section is a page of that plugin's world, and showing it
  // here as well put the same surface in two places at once. Remembered categories and old links still
  // arrive with a `plugin:` id, so they are forwarded to that page rather than dropped on the floor —
  // and a section whose plugin is gone (disabled, uninstalled) falls back to `system`.
  useEffect(() => {
    if (!pluginUi.data || !isPluginSettingsSectionId(category)) return;
    setCategoryState('system'); // never leave the deck remembering a category it can no longer render
    const parsed = parsePluginSettingsSectionId(category);
    const entry = parsed && pluginUi.data.find((p) => p.name === parsed.plugin);
    if (parsed && entry?.settings.some((s) => s.id === parsed.settingId)) router.replace(pluginSectionHref(entry, parsed.settingId));
  }, [pluginUi.data, category, setCategoryState, router]);
  // React to CLIENT-side URL changes — the sidebar's nested settings sub-items navigate to `?cat=x`
  // without remounting the page, and useSearchParams updates on those.
  const urlCat = searchParams.get('cat');
  useEffect(() => { if (isValidCat(urlCat)) setCategoryState(urlCat); }, [urlCat]); // eslint-disable-line react-hooks/exhaustive-deps
  // On first load / F5, apply a valid `?cat=` from the ACTUAL URL, and follow popstate afterwards —
  // both the sidebar's same-page section switches (which push the URL + fire popstate) and the browser
  // back/forward buttons. This route is statically optimized, so useSearchParams reads EMPTY until a
  // client navigation; reading window.location directly is the reliable source. Runs after
  // usePersistentState's localStorage hydration, so an explicit URL section overrides the remembered one.
  useEffect(() => {
    const apply = () => { const cat = new URLSearchParams(window.location.search).get('cat'); if (isValidCat(cat)) setCategoryState(cat); };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // …and the row within it, when the link named one: `?row=<anchor>` scrolls that record into view and
  // blinks it once. It reads the same three sources this section state does and consumes the parameter.
  useRowAnchor();
  const setCategory = (next: string) => {
    setCategoryState(next);
    // Rewrite the URL directly (the Next router's replace() doesn't reliably update this statically
    // optimized route), then fire popstate so the sidebar's active-item highlight follows. F5 restores
    // this exact section from the URL.
    window.history.replaceState(null, '', `/settings?cat=${next}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const [allowed, setAllowed] = useState<string[]>([]);
  // Per-model max context window overrides (Elowen AI models only), keyed `providerId/model`. Lives here
  // in the Models section next to where models are enabled — one home for all Elowen AI model config.
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState('');
  // The Elowen AI model whose context-window override is being edited (null = editor closed).
  const [ctxFor, setCtxFor] = useState<{ model: string; key: string; effective: number } | null>(null);
  const [defTokenTtl, setDefTokenTtl] = useState(30);
  const [tokenTtlOpen, setTokenTtlOpen] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [pushContact, setPushContact] = useState('');

  // Conversation auto-cleanup: the daemon's hourly janitor deletes idle conversations older than N
  // days. Off by default; it never touches running/active/channel sessions. The row stays compact while
  // the shared days editor lives in a drawer and persists independently of the token-TTL autosave.
  const retention = config.data?.sessionRetention ?? { enabled: false, days: 90 };
  const [retentionEnabled, setRetentionEnabledState] = useState(false);
  const [retentionDays, setRetentionDays] = useState(90);
  const retentionDirty = useRef<Partial<{ enabled: boolean; days: number }>>({});
  const [retentionOpen, setRetentionOpen] = useState(false);

  // Seed the form from the config ONCE. useConfig is stale-while-revalidate, so it refetches on
  // window focus; re-seeding on every refetch would wipe a model the user just added before they
  // hit Save. We seed on first load only — subsequent server updates don't clobber in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (config.data && !seeded.current) {
      seeded.current = true;
      setAllowed(config.data.allowedExecs ?? []);
      setModelWindows(config.data.brain?.modelContextWindows ?? {});
      setDefTokenTtl(config.data.security?.tokenTtlDays ?? 30);
      setAutoUpdate(config.data.autoUpdate ?? false);
      setPushContact(config.data.webPushContact ?? '');
      setRetentionEnabledState(config.data.sessionRetention?.enabled ?? false);
      setRetentionDays(config.data.sessionRetention?.days ?? 90);
    }
  }, [config.data]);

  // The run defaults (executor/autonomy/max sessions) moved to the agents plugin's settings deck;
  // only the token TTL stays with the core System section. autoUpdate is NOT bundled here — the
  // System toggle is its single writer (it persists inline).
  const saveDefaults = async () => {
    try { await update.mutateAsync({ security: { tokenTtlDays: defTokenTtl } }); }
    catch (error) { toast(apiErrorMessage(error), 'error'); throw error; }
  };

  // Retention is an ordinary scalar/toggle record: save it immediately through the shared status
  // controller, while tracking changed keys so sibling values are never replayed from a stale draft.
  const setRetentionEnabled = (next: boolean) => {
    retentionDirty.current.enabled = next;
    setRetentionEnabledState(next);
  };
  const setRetentionPolicyDays = (days: number) => {
    retentionDirty.current.days = days;
    setRetentionDays(days);
  };
  const retentionSave = useAutoSaveStatus([retentionEnabled, retentionDays], async () => {
    const patch = { ...retentionDirty.current };
    if (Object.keys(patch).length === 0) return;
    try {
      await update.mutateAsync({ sessionRetention: patch });
      // The request response is authoritative for the server cache, but this draft remains the user's
      // current intent; applying a stale sibling snapshot here would overwrite a newer local edit.
      if (patch.enabled !== undefined && retentionDirty.current.enabled === patch.enabled) delete retentionDirty.current.enabled;
      if (patch.days !== undefined && retentionDirty.current.days === patch.days) delete retentionDirty.current.days;
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      throw error;
    }
  }, { ready: seeded.current, delay: 0 });
  // Auto-persist: every settings form saves itself shortly after a change (no Save buttons anywhere).
  // The apiKey secret rides along only when freshly typed, exactly as with the old buttons.
  const ready = seeded.current;
  const defaultsSave = useAutoSaveStatus([defTokenTtl], saveDefaults, { ready });
  // Per-model context windows auto-persist like every other model setting (no Save button).
  const windowsSave = useAutoSaveStatus([modelWindows], async () => {
    try { await update.mutateAsync({ brain: { modelContextWindows: modelWindows } }); }
    catch (error) { toast(apiErrorMessage(error), 'error'); throw error; }
  }, { ready });
  const modelsSave = useAutoSaveStatus([allowed], async () => {
    try { await update.mutateAsync({ allowedExecs: allowed }); }
    catch (error) { toast(apiErrorMessage(error), 'error'); throw error; }
  }, { ready, delay: 0 });
  const autoUpdateSave = useAutoSaveStatus([autoUpdate], async () => {
    try { await update.mutateAsync({ autoUpdate }); }
    catch (error) { toast(apiErrorMessage(error), 'error'); throw error; }
  }, { ready, delay: 0 });
  const pushContactSave = useAutoSaveStatus([pushContact], async () => {
    try { await update.mutateAsync({ webPushContact: pushContact }); }
    catch (error) { toast(apiErrorMessage(error), 'error'); throw error; }
  }, { ready });
  const closeTokenTtl = async () => {
    const finalStatus = await defaultsSave.flush();
    if (finalStatus !== 'error') setTokenTtlOpen(false);
  };
  const closeRetention = async () => {
    const finalStatus = await retentionSave.flush();
    if (finalStatus !== 'error') setRetentionOpen(false);
  };
  // Set (or clear, with null) one model's context-window override; the autosave above persists it.
  const setWindow = (key: string, value: number | null) =>
    setModelWindows((cur) => {
      const next = { ...cur };
      if (value != null && value >= 1) next[key] = Math.floor(value);
      else delete next[key];
      return next;
    });

  if (config.isLoading) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><LoadingState /></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><ErrorState message={t.common.daemonUnreachable} onRetry={() => config.refetch()} /></ModuleShell>;
  // Administration surface — admins only. A non-admin who deep-links here gets a clear stop.
  if (me.data?.user && !me.data.user.is_admin) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><EmptyState title={t.settings.adminOnly} description={t.settings.adminOnlyDesc} icon={Lock} /></ModuleShell>;

  // Model allow-list changes auto-persist immediately. The catalog itself is owned by configured brain
  // providers; retired worker presets and custom worker entries are not editable on this surface.
  const toggle = (exec: string) =>
    setAllowed((current) => current.includes(exec) ? current.filter((entry) => entry !== exec) : [...current, exec]);

  // 'models' auto-saves; 'data' is a one-off danger action; 'system'
  // auto-saves its toggle + has its own update button; 'plugins' toggles apply instantly — none of
  // these use the shared footer save button.

  // Sections that report their own state (core panels and plugin-contributed ones alike) come straight
  // from the sink; the two whose state is assembled from several independent autosaves are folded here.
  const feedbackByCategory: Partial<Record<string, SaveFeedback>> = {
    ...sectionFeedback,
    // The roles group reports its three autosaves (embedding, utility, digest) already folded into one;
    // it is folded again here with the catalog's own saves so the deck header speaks for the whole section
    // rather than for whichever half saved last.
    models: combineSaveFeedback(modelsSave, windowsSave, sectionFeedback.models ?? { status: 'idle' }),
    system: combineSaveFeedback(autoUpdateSave, defaultsSave, pushContactSave, retentionSave),
  };
  const activeFeedback = feedbackByCategory[category] ?? { status: 'idle' as const };
  const sectionHints: Record<Category, string> = {
    models: t.settings.modelsSectionHint,
    brain: t.settings.brainSectionHint,
    dashboard: t.settings.dashboardSectionHint,
    plugins: t.settings.pluginsSectionHint,
    data: t.settings.dataSectionHint,
    system: t.settings.systemSectionHint,
  };
  // Core sections, in their fixed order. Plugins do not appear here: each owns a world in the main
  // navigation and its settings sections are pages of that world.
  const deckSections = SETTINGS_SECTIONS.map(({ id, icon }) => ({ id, icon, label: id === 'brain' ? agentAiLabel : t.settings[id], description: sectionHints[id] }));
  const diagnostics = system.data?.diagnostics;
  const activeSection = deckSections.find((section) => section.id === category) ?? deckSections[0]!;

  // THE METRIC RAIL, one set per section. Every figure is read from state or from a query this page
  // ALREADY holds — the config, the brain catalog, the plugin listing, the model form state, and (only
  // while Data is on screen) the log summary. No section adds a request of its own, and none reports a
  // number it cannot also explain in the records below it. A value that has not arrived yet is an em
  // dash rather than a zero, because "no answer yet" and "none" are different answers.
  const brainProviders = config.data?.brain?.providers ?? [];
  const brainCatalog = brainModels.data ?? [];
  const brainModelGroups = groupBrainModelsByProvider(brainCatalog);
  const catalogExecs = brainCatalog.map((model) => model.exec);
  const pluginEntries = pluginUi.data ?? [];
  const logBytes = logFiles.data?.files.reduce((sum, file) => sum + file.bytes, 0);
  const sectionMetrics: Record<Category, ReactNode> = {
    system: (
      <>
        <WorkspaceMetric label={t.settings.version.replace('{productName}', brand.appName)} value={<span className="font-mono">{system.data?.version ?? '—'}</span>} icon={Sparkles} />
        <WorkspaceMetric label={t.settings.serviceDaemon} value={system.isError ? t.settings.serviceDown : t.settings.serviceUp} icon={Server} />
        <WorkspaceMetric label={t.settings.diagnosticMemory} value={diagnostics ? `${Math.round((diagnostics.memoryUsedBytes / diagnostics.memoryTotalBytes) * 100)} %` : '—'} icon={MemoryStick} />
        <WorkspaceMetric label={t.settings.diagnosticUptime} value={diagnostics ? formatUptime(diagnostics.uptimeSeconds) : '—'} icon={Timer} />
      </>
    ),
    brain: (
      <>
        <WorkspaceMetric label={t.settings.metric.accounts} value={brainProviders.length} icon={Server} />
        {/* An OAuth account carries no API key, so "has a key" would report every connected Claude or
            Codex account as unconfigured. Both halves of the union count as connected. */}
        <WorkspaceMetric label={t.settings.metric.connected} value={brainProviders.filter((p) => p.apiKeySet || p.type.startsWith('oauth-')).length} icon={KeyRound} />
        <WorkspaceMetric label={t.settings.metric.aiModels} value={brainCatalog.length} icon={Boxes} />
      </>
    ),
    models: (
      <>
        <WorkspaceMetric label={t.settings.metric.catalog} value={catalogExecs.length} icon={Boxes} />
        <WorkspaceMetric label={t.settings.metric.enabled} value={catalogExecs.filter((exec) => allowed.includes(exec)).length} icon={ToggleRight} />
        <WorkspaceMetric label={t.settings.metric.accounts} value={brainModelGroups.length} icon={Server} />
        <WorkspaceMetric label={t.settings.metric.overrides} value={Object.keys(modelWindows).length} icon={Gauge} />
      </>
    ),
    plugins: (
      <>
        {/* What this page can see is the UI listing, so the labels say exactly that rather than implying
            a total installed count the deck never fetched. */}
        <WorkspaceMetric label={t.settings.metric.pluginWorlds} value={pluginEntries.length} icon={Boxes} />
        <WorkspaceMetric label={t.settings.metric.pluginPages} value={pluginEntries.reduce((n, entry) => n + entry.nav.length, 0)} icon={Blocks} />
        <WorkspaceMetric label={t.settings.metric.pluginSections} value={pluginEntries.reduce((n, entry) => n + entry.settings.length, 0)} icon={SlidersHorizontal} />
      </>
    ),
    dashboard: (
      <>
        <WorkspaceMetric label={t.settings.dashboardSection.recap} value={config.data?.dashboard?.recapEnabled === false ? t.settings.off : t.settings.on} icon={LayoutDashboard} />
        <WorkspaceMetric label={t.settings.dashboardSection.digest} value={config.data?.dashboard?.digestEnabled === false ? t.settings.off : t.settings.on} icon={Sparkles} />
        <WorkspaceMetric
          label={t.settings.dashboardSection.model}
          value={config.data?.dashboard?.digest.model
            ? <span className="font-mono">{config.data.dashboard.digest.model}</span>
            : t.settings.dashboardSection.providerInherit}
          icon={Boxes}
        />
      </>
    ),
    data: (
      <>
        <WorkspaceMetric label={t.settings.metric.logFiles} value={logFiles.data?.files.length ?? '—'} icon={ScrollText} />
        <WorkspaceMetric label={t.settings.metric.logVolume} value={logBytes === undefined ? '—' : formatBytes(logBytes)} icon={HardDrive} />
        <WorkspaceMetric label={t.settings.metric.requestCapture} value={config.data?.runtime?.providerRequestCaptureEnabled === false ? t.settings.off : t.settings.on} icon={MessageSquareText} />
        <WorkspaceMetric
          label={t.settings.metric.conversationCleanup}
          value={retention.enabled ? `${retention.days} ${t.settings.retention.days}` : t.settings.off}
          icon={CalendarClock}
        />
      </>
    ),
  };

  // The hero answers "is this instance healthy right now" on every settings tab, and carries the one
  // action an operator reaches for after changing something. Restarting still goes through the same
  // confirmation as the row in the System section — this is a second door to it, not a second path.
  const deckHero = {
    eyebrow: t.page.settings,
    title: activeSection.label,
    description: activeSection.description,
    status: <AutoSaveStatus status={activeFeedback.status} onRetry={activeFeedback.retry} />,
    // Instance health and restart actions belong to System. Repeating them over Models, Plugins or Memory
    // made every mobile section open with unrelated controls before its own content.
    mascot: category === 'system' ? (system.isError ? 'error' : systemRestart.isPending ? 'saving' : 'idle') as 'error' | 'saving' | 'idle' : false,
    action: category === 'system' ? (
      <>
        <Button icon={RotateCcw} disabled={systemRestart.isPending} onClick={() => setRestartTarget('daemon')}>
          {t.settings.restartDaemon}
        </Button>
        <Button icon={RotateCcw} disabled={systemRestart.isPending} onClick={() => setRestartTarget('web')}>
          {t.settings.restartWeb}
        </Button>
      </>
    ) : undefined,
    // Keyed on the section actually on screen, not on the stored `category`: a remembered plugin section
    // renders the System deck for the one paint before the redirect, and its rail must agree with it.
    metrics: sectionMetrics[activeSection.id],
  } satisfies WorkspaceHeroProps;

  // The page's ONE row of controls, in the canonical toolbar under the section navigation. It is keyed on
  // the active section rather than declared per panel, because the panels stay mounted while hidden: a
  // toolbar owned by each panel would leave the retained ones competing for the same row. Sections that
  // carry no page-level control (System, Memory, Data) pass nothing and the row collapses.
  // Plugins is the exception: its search, view and category filter are the section's own state, so it
  // fills the row through the toolbar's portal instead (see PluginsSection).
  const toolbar: PageToolbarProps | undefined =
    category === 'models' ? {
      search: (
        <RegisterSearch
          value={modelQuery}
          onChange={setModelQuery}
          placeholder={t.settings.modelSearchPlaceholder}
          label={t.settings.modelSearchPlaceholder}
        />
      ),
    } : category === 'brain' ? {
      // Cross-link to the model catalog (enable / context-window per model) — the Models section.
      actions: <Button variant="ghost" size="sm" icon={Boxes} onClick={() => setCategory('models')}>{t.settings.brainModelsLink}</Button>,
    } : undefined;

  return (
    <ModuleShell moduleId="settings">
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal} />

      <div className="flex w-full min-w-0 flex-col">
      <WorkspaceShell
        variant="deck"
        hero={deckHero}
        navigation={{ sections: deckSections, value: activeSection.id, onChange: setCategory, ariaLabel: t.settings.sectionsNav }}
        toolbar={toolbar}
      >
        <SettingsPanel id="models" active={category} visited={visitedCategories}>
          <>
            {/* WHICH MODEL DOES WHAT comes first; the catalog below answers WHICH MODELS EXIST. The two
                halves of the same question, in the order someone asks them. */}
            <ModelRolesSection onSaveState={reportSaveState} onOpenSection={setCategory} />
            {/* The catalog's own heading. A title only: the per-provider cards below carry the rows and
                stay exactly as they are, but without this the page went from the roles group straight to
                unlabelled provider cards and the second half of the question had no name. */}
            <SettingsGroup title={t.settings.modelCatalog} description={t.settings.modelCatalogHint} icon={Boxes} />
            {/* The same provider groups drive these catalog cards and every model picker. The provider id
                comes from the daemon's structured catalog; model ids remain opaque and may contain slashes. */}
            {brainModelGroups.map((group) => {
              const needle = modelQuery.trim().toLocaleLowerCase();
              const visibleModels = needle
                ? group.models.filter((model) => `${group.label} ${model.model} ${model.exec}`.toLocaleLowerCase().includes(needle))
                : group.models;
              if (visibleModels.length === 0) return null;
              const enabledCount = group.models.filter((model) => allowed.includes(model.exec)).length;
              return (
                <SettingsGroup key={group.id} density="compact">
                  <header className="settings-group__header">
                    <div className="settings-group__heading">
                      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted text-muted-foreground">
                        <ModelIcon name={group.label} size={17} />
                      </span>
                      <div className="flex items-center gap-2">
                        <h2>{group.label}</h2>
                        <span className="font-mono text-tiny text-muted-foreground">{enabledCount}/{group.models.length}</span>
                      </div>
                    </div>
                  </header>
                  <div className="settings-model-rows @container">
                    {visibleModels.map((model) => {
                      const winKey = `${model.provider}/${model.model}`;
                      // Local state is the live truth for overrides (seeded from the same config
                      // `contextWindowSet` derives from, then autosaved), so a just-set or just-cleared
                      // override renders immediately without waiting for a refetch.
                      const override = modelWindows[winKey];
                      const overridden = override != null;
                      return (
                        <div data-testid="model-row" key={model.exec} className="settings-model-row settings-model-row--elowen flex min-w-0 items-center gap-3 transition-colors">
                          <span className="settings-model-row__icon flex h-9 w-9 shrink-0 items-center justify-center text-muted-foreground"><ModelIcon name={model.model} size={20} /></span>
                          <div className="settings-model-row__identity min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-foreground">{model.model}</span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">{model.exec}</span>
                          </div>
                          <div className="settings-model-row__controls ml-auto flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setCtxFor({ model: model.model, key: winKey, effective: model.contextWindow })}
                              title={`${t.brain.contextWindowEdit} · ${formatTokens(override ?? model.contextWindow)}`}
                              aria-label={`${t.brain.contextWindowEdit}: ${model.model}`}
                              className={`settings-model-row__context inline-flex h-8 shrink-0 items-center gap-1 px-2 font-mono text-[11px] transition-colors ${overridden ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                            >
                              <Gauge size={12} aria-hidden />
                              {formatTokens(override ?? model.contextWindow)}
                            </button>
                            <Toggle checked={allowed.includes(model.exec)} onChange={() => toggle(model.exec)} label={model.model} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </SettingsGroup>
              );
            })}

            {modelQuery.trim() && !brainModelGroups.some((group) => group.models.some((model) =>
              `${group.label} ${model.model} ${model.exec}`.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase()))) ? (
              <SettingsState>{t.settings.modelNoMatches}</SettingsState>
            ) : null}

          </>
        </SettingsPanel>

        {ctxFor && (
          <ContextWindowModal
            model={ctxFor.model}
            initial={modelWindows[ctxFor.key] ?? null}
            effective={ctxFor.effective}
            onClose={() => setCtxFor(null)}
            onSave={(v) => setWindow(ctxFor.key, v)}
          />
        )}

        <SettingsPanel id="system" active={category} visited={visitedCategories}>
          
            {(() => {
              // One card of instance records, with the diagnostics widget below it.
              const updateBadge = system.data?.updateAvailable
                ? <Badge tone="warning">{t.settings.updateAvailable.replace('{v}', system.data?.latest ?? '')}</Badge>
                : <Badge tone="success">{t.settings.upToDate}</Badge>;
              const rowVersion = (
                // The version number and the last-updated stamp moved to the deck hero above, so this
                // row is left with the one thing it still answers: whether an update is waiting.
                <SettingsRow
                  label={brand.appName}
                  icon={Sparkles}
                  actions={(
                    <>
                      {/* The badge IS the check button: it already states the answer, so a separate
                          "check for updates" control next to it said the same thing twice. */}
                      <button
                        type="button"
                        className="rounded-full transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-60"
                        aria-label={t.settings.checkUpdates}
                        title={t.settings.checkUpdates}
                        disabled={system.isFetching}
                        onClick={() => { void system.refetch(); }}
                      >
                        {updateBadge}
                      </button>
                      {system.data?.updateAvailable ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={RefreshCw}
                          disabled={systemUpdate.isPending}
                          onClick={() => systemUpdate.mutate(undefined, {
                            onSuccess: () => toast(t.settings.updateStarted),
                            onError: (e) => toast(String(e), 'error'),
                          })}
                        >
                          {systemUpdate.isPending ? t.settings.updating : t.settings.updateNow}
                        </Button>
                      ) : null}
                    </>
                  )}
                />
              );
              {/* Reporting only. Both restarts live in the deck hero, where they are reachable from every
                  settings section instead of just this one — a second copy here would be two doors to the
                  same confirmation with no way to tell them apart. */}
              const serviceRows = [
                { name: t.settings.serviceDaemon, rowId: rowAnchor('settings.serviceDaemon'), port: ':4400', up: !system.isError },
                { name: t.settings.serviceWeb, rowId: rowAnchor('settings.serviceWeb'), port: ':4500', up: true },
              ].map((service) => (
                <SettingsRow
                  key={service.port}
                  label={service.name}
                  rowId={service.rowId}
                  icon={Server}
                  // Port and state are ONE trailing value, not a status beside a control: neither half is
                  // operable, and splitting them put a reading in the cell the record's control belongs in.
                  status={(
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{service.port}</span>
                      <span className={`settings-control-row__status ${service.up ? '' : 'settings-control-row__status--down'}`}><i aria-hidden />{service.up ? t.settings.serviceUp : t.settings.serviceDown}</span>
                    </span>
                  )}
                />
              ));
              const rowAutoUpdate = (
                <SettingsRow
                  label={t.settings.autoUpdate}
                  rowId={rowAnchor('settings.autoUpdate')}
                  icon={RefreshCw}
                  control={<Toggle checked={autoUpdate} onChange={setAutoUpdate} label={t.settings.autoUpdate} />}
                />
              );
              const rowPushContact = (
                <SettingsRow
                  label={t.settings.pushContact}
                  rowId={rowAnchor('settings.pushContact')}
                  description={t.help.pushContact}
                  icon={BellRing}
                  control={<Input value={pushContact} onChange={(e) => setPushContact(e.target.value)} placeholder={t.settings.pushContactPlaceholder} aria-label={t.settings.pushContact} />}
                />
              );
              const rowTokenTtl = (
                <SettingsRow
                  label={t.settings.tokenTtl}
                  rowId={rowAnchor('settings.tokenTtl')}
                  description={t.help.tokenTtl}
                  icon={KeyRound}
                  status={<span className="whitespace-nowrap font-mono tabular-nums">{interpolate(t.settings.daysPolicy.value, { n: String(defTokenTtl) })}</span>}
                  actions={(
                    <Button variant="ghost" size="sm" icon={KeyRound} onClick={() => setTokenTtlOpen(true)}>
                      {t.settings.tokenTtlEdit}
                    </Button>
                  )}
                />
              );
              const rowRetention = (
                <SettingsRow
                  label={t.settings.retention.label}
                  rowId={rowAnchor('settings.retention.label')}
                  description={t.settings.retention.hint}
                  icon={CalendarClock}
                  control={<Toggle checked={retentionEnabled} onChange={setRetentionEnabled} label={t.settings.retention.label} />}
                  status={<span className="flex items-center gap-2"><AutoSaveStatus status={retentionSave.status} onRetry={retentionSave.retry} />{retentionEnabled ? <span className="whitespace-nowrap font-mono tabular-nums">{interpolate(t.settings.daysPolicy.value, { n: String(retentionDays) })}</span> : null}</span>}
                  actions={(
                    <Button variant="ghost" size="sm" icon={CalendarClock} onClick={() => setRetentionOpen(true)}>
                      {t.settings.retention.edit}
                    </Button>
                  )}
                />
              );
              const tokenTtlDrawer = tokenTtlOpen ? (
                <Modal
                  title={t.settings.tokenTtl}
                  description={t.help.tokenTtl}
                  icon={KeyRound}
                  closeLabel={t.common.close}
                  intent="inspect"
                  size="sm"
                  drawerWidth="default"
                  onClose={closeTokenTtl}
                  closeDisabled={defaultsSave.status === 'saving' || defaultsSave.status === 'error'}
                >
                  <ModalBody>
                    <DaysPolicyEditor
                      value={defTokenTtl}
                      presets={TOKEN_TTL_PRESETS}
                      label={t.settings.tokenTtl}
                      onCommit={setDefTokenTtl}
                    />
                  </ModalBody>
                  <ModalFooter status={<AutoSaveStatus status={defaultsSave.status} onRetry={defaultsSave.retry} />}>
                    <Button variant="accent" onClick={closeTokenTtl} disabled={defaultsSave.status === 'saving' || defaultsSave.status === 'error'}>{t.common.done}</Button>
                  </ModalFooter>
                </Modal>
              ) : null;
              const retentionDrawer = retentionOpen ? (
                <Modal
                  title={t.settings.retention.label}
                  description={t.settings.retention.hint}
                  icon={CalendarClock}
                  closeLabel={t.common.close}
                  intent="inspect"
                  size="sm"
                  drawerWidth="default"
                  onClose={closeRetention}
                  closeDisabled={retentionSave.status === 'saving' || retentionSave.status === 'error'}
                >
                  <ModalBody>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-foreground">{t.settings.retention.label}</span>
                      <Toggle checked={retentionEnabled} onChange={setRetentionEnabled} label={t.settings.retention.label} />
                    </div>
                    <fieldset disabled={retentionSave.status === 'saving' || update.isPending} className="contents">
                      <DaysPolicyEditor
                        value={retentionDays}
                        presets={SESSION_RETENTION_PRESETS}
                        label={t.settings.retention.olderThan}
                        onCommit={setRetentionPolicyDays}
                      />
                    </fieldset>
                  </ModalBody>
                  <ModalFooter status={<AutoSaveStatus status={retentionSave.status} onRetry={retentionSave.retry} />}>
                    <Button variant="accent" onClick={closeRetention} disabled={retentionSave.status === 'saving' || retentionSave.status === 'error'}>{t.common.done}</Button>
                  </ModalFooter>
                </Modal>
              ) : null;
              const diagnosticsGroup = (
                <SettingsGroup title={t.settings.systemDiagnostics} rowId={rowAnchor('settings.systemDiagnostics')} description={t.settings.systemSectionHint} icon={Gauge} className="settings-diagnostics">
                  <SystemDiagnostics
                    diagnostics={diagnostics}
                    t={t}
                    formatMemory={formatMemory}
                    formatUptime={formatUptime}
                  />
                </SettingsGroup>
              );
              return (
                <div className="flex flex-col gap-4">
                  <SettingsGroup columns={2}>
                    {rowVersion}
                    {serviceRows}
                    {rowAutoUpdate}
                    <SkinsRow />
                    {rowPushContact}
                    {rowTokenTtl}
                    {rowRetention}
                  </SettingsGroup>
                  {diagnosticsGroup}
                  {tokenTtlDrawer}
                  {retentionDrawer}
                </div>
              );
            })()}
          
        </SettingsPanel>

        <SettingsPanel id="brain" active={category} visited={visitedCategories}>
          <BrainSection onSaveState={reportSaveState} />
        </SettingsPanel>

        <SettingsPanel id="dashboard" active={category} visited={visitedCategories}>
          <DashboardSection onSaveState={reportSaveState} onOpenSection={setCategory} />
        </SettingsPanel>

        <SettingsPanel id="plugins" active={category} visited={visitedCategories}><PluginsSection /></SettingsPanel>

        <SettingsPanel id="data" active={category} visited={visitedCategories}>
          {/* Header only, like the log viewer below it: the capture switch and the sensitivity notice
              belong to the viewer itself, where they have context, not to a settings row nobody reads. */}
          <SettingsGroup
            title={t.settings.conversationDiagnostics.title}
            rowId={rowAnchor('settings.conversationDiagnostics.title')}
            icon={MessageSquareText}
            actions={<Button icon={MessageSquareText} onClick={() => setConversationDiagnosticsOpen(true)}>{t.settings.conversationDiagnostics.open}</Button>}
          />
          {/* Header only. The directory and the per-file breakdown are one click away in the viewer, so
              repeating them here bought a row between two sections and nothing else. */}
          <SettingsGroup
            title={logFiles.data
              ? `${t.settings.logs} · ${formatBytes(logFiles.data.files.reduce((sum, f) => sum + f.bytes, 0))}`
              : t.settings.logs}
            rowId={rowAnchor('settings.logs')}
            icon={ScrollText}
            actions={<Button icon={ScrollText} onClick={() => setLogsOpen(true)}>{t.settings.logsOpen}</Button>}
          />

        </SettingsPanel>

      </WorkspaceShell>
      </div>

      {logsOpen ? <LogsModal onClose={() => setLogsOpen(false)} /> : null}
      {conversationDiagnosticsOpen ? (
        <ConversationDiagnosticsModal
          captureEnabled={config.data?.runtime?.providerRequestCaptureEnabled !== false}
          onEnableCapture={() => update.mutateAsync({ runtime: { providerRequestCaptureEnabled: true } }).then(() => undefined)}
          onClose={() => setConversationDiagnosticsOpen(false)}
        />
      ) : null}

      <ConfirmDialog
        open={restartTarget !== null}
        title={restartTarget === 'web' ? t.settings.restartWebTitle : t.settings.restartDaemonTitle}
        description={restartTarget === 'web' ? t.settings.restartWebDesc : t.settings.restartDaemonDesc}
        confirmLabel={t.settings.restartConfirm}
        onConfirm={() => {
          const target = restartTarget;
          setRestartTarget(null);
          if (!target) return;
          systemRestart.mutate(target, {
            onSuccess: () => toast(target === 'daemon' ? t.settings.restartDaemonStarted : t.settings.restartWebStarted),
            onError: (e) => toast(String(e), 'error'),
          });
        }}
        onClose={() => setRestartTarget(null)}
      />

    </ModuleShell>
  );
}
