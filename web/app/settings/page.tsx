'use client';
export const dynamic = 'force-dynamic';
// Aliased: `dynamic` is already this route's Next segment-config export, two lines up.
import nextDynamic from 'next/dynamic';
import { Activity, useCallback, useEffect, useState, useRef, type ReactNode } from 'react';
import { SlidersHorizontal, X, Pencil, Gauge, Lock, RefreshCw, RotateCcw, Sparkles, KeyRound, Search, Server, CalendarClock, ScrollText, BellRing, MessageSquareText, MemoryStick, Timer } from 'lucide-react';
import { PROVIDERS, ProviderLogo } from '../../modules/settings/providers';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ModelModal } from '../../modules/settings/ModelModal';
import { ModelNoteModal } from '../../modules/settings/ModelNoteModal';
import { ContextWindowModal } from '../../modules/settings/ContextWindowModal';
import { PluginsSection } from '../../modules/settings/PluginsSection';
import { BrainSection } from '../../modules/settings/BrainSection';
import { MemorySection } from '../../modules/settings/MemorySection';
import { execProvider, execModel, type ProviderId } from '../../lib/modelProvider';
import { formatTokens } from '../../lib/format';
import { useBrainModels, useConfig, useMe, usePluginUi, useSystem, useLogFiles } from '../../lib/queries';
import { useBrand } from '../../lib/brand';
import { LogsModal } from '../../modules/settings/LogsModal';
import { ConversationDiagnosticsModal } from '../../modules/settings/ConversationDiagnosticsModal';
import { formatBytes } from '../../lib/format';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback, type SaveFeedback } from '../../lib/saveFeedback';
import { useUpdateConfig, useSystemUpdate, useSystemRestart } from '../../lib/mutations';
import { allModels, isPresetExec, removeModel, upsertModel } from '../../lib/execPresets';
import { usePersistentState } from '../../lib/usePersistentState';
import { useRouter, useSearchParams } from 'next/navigation';
import { SETTINGS_CATEGORY_VALUES, SETTINGS_SECTIONS, type SettingsCategory } from '../../modules/settings/categories';
import { isPluginSettingsSectionId, parsePluginSettingsSectionId } from '../../modules/settings/pluginSections';
import { pluginSectionHref } from '../../lib/pluginNav';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { WorkspaceLeadScope, WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { WorkspaceMetric, type WorkspaceHeroProps } from '../../components/ui/WorkspaceHero';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { SettingsDocument, SettingsGroup, SettingsRow, SettingsToolbar, SettingsState } from '../../components/ui/SettingsSurface';
import { SkinsRow } from '../../modules/settings/SkinsRow';
import { MotionReveal } from '../../components/ui/Motion';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import { interpolate, useTranslation } from '../../lib/i18n';

/** Loaded on demand: the dials pull in the charting library, and Settings is a heavy page where most
 *  visits never scroll to the System section. `ssr: false` because the dials measure their own box,
 *  which is zero on the server. The placeholder reserves the drawn height so the page does not jump. */
const SystemDiagnostics = nextDynamic(
  () => import('../../modules/settings/SystemDiagnostics').then((m) => m.SystemDiagnostics),
  { ssr: false, loading: () => <LoadingState variant="block" height="h-[150px]" /> },
);

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

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

/** A deck section id: a core category, or a plugin-contributed `plugin:<name>:<id>` section. Stored
 *  state validates by SHAPE (the plugin listing loads asynchronously); the listing then confirms a
 *  plugin section still exists and falls back to `system` when its plugin was disabled. */
const isSectionId = (value: string): boolean =>
  (CATEGORY_VALUES as readonly string[]).includes(value) || isPluginSettingsSectionId(value);

/** Categories rendered as an orbital constellation (rows become pods, composites edit in drawers,
 *  the document card frame drops). The rest — catalogs, lists and data views — stay classic. */
const ORBITAL_CATEGORIES: ReadonlySet<string> = new Set<Category>(['system', 'brain', 'memory']);

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
  const [category, setCategoryState] = usePersistentState<string>('elowen.settings.category', 'system', isSectionId);
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
  const isValidCat = (c: string | null): c is string => !!c && isSectionId(c);
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
  const setCategory = (next: string) => {
    setCategoryState(next);
    // Rewrite the URL directly (the Next router's replace() doesn't reliably update this statically
    // optimized route), then fire popstate so the sidebar's active-item highlight follows. F5 restores
    // this exact section from the URL.
    window.history.replaceState(null, '', `/settings?cat=${next}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [modelNotes, setModelNotes] = useState<Record<string, string>>({});
  // Per-model max context window overrides (Elowen AI models only), keyed `providerId/model`. Lives here
  // in the Models section next to where models are enabled — one home for all Elowen AI model config.
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({});
  const [modelQuery, setModelQuery] = useState('');
  // The model whose model description is being edited (null = editor closed).
  const [noteFor, setNoteFor] = useState<{ label: string; exec: string } | null>(null);
  // The Elowen AI model whose context-window override is being edited (null = editor closed).
  const [ctxFor, setCtxFor] = useState<{ model: string; key: string; effective: number } | null>(null);
  const [defTokenTtl, setDefTokenTtl] = useState(30);
  const [autoUpdate, setAutoUpdate] = useState(false);
  const [pushContact, setPushContact] = useState('');

  // Conversation auto-cleanup: the daemon's hourly janitor deletes idle conversations older than N
  // days. Off by default; it never touches running/active/channel sessions. Saved immediately
  // (toggle) or on blur/Enter (days), clamped to >= 1, reverting an invalid draft. Persists
  // independently of the token-TTL defaults autosave.
  const retention = config.data?.sessionRetention ?? { enabled: false, days: 90 };
  const [retentionDaysDraft, setRetentionDaysDraft] = useState('');
  // The retention composite edits in a side drawer opened via its pod's orb (mirrors auto-compact).
  const [retentionOpen, setRetentionOpen] = useState(false);

  // Add / edit model modal state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingExec, setEditingExec] = useState<string | null>(null);

  const [hiddenPresets, setHiddenPresets] = useState<string[]>([]);

  // Pending delete (drives the ConfirmDialog)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Seed the form from the config ONCE. useConfig is stale-while-revalidate, so it refetches on
  // window focus; re-seeding on every refetch would wipe a model the user just added before they
  // hit Save. We seed on first load only — subsequent server updates don't clobber in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (config.data && !seeded.current) {
      seeded.current = true;
      setAllowed(config.data.allowedExecs);
      setCustomModels(config.data.customModels ?? []);
      setModelNotes(config.data.modelNotes ?? {});
      setModelWindows(config.data.brain?.modelContextWindows ?? {});
      setHiddenPresets(config.data.hiddenPresets ?? []);
      setDefTokenTtl(config.data.security?.tokenTtlDays ?? 30);
      setAutoUpdate(config.data.autoUpdate ?? false);
      setPushContact(config.data.webPushContact ?? '');
    }
  }, [config.data]);

  // The retention days field tracks the stored value directly (not the one-shot seed above), so an
  // external change is reflected and an invalid draft can revert to the saved number.
  useEffect(() => { setRetentionDaysDraft(String(retention.days)); }, [retention.days]);

  // The run defaults (executor/autonomy/max sessions) moved to the agents plugin's settings deck;
  // only the token TTL stays with the core System section. autoUpdate is NOT bundled here — the
  // System toggle is its single writer (it persists inline).
  const saveDefaults = async () => {
    try { await update.mutateAsync({ security: { tokenTtlDays: defTokenTtl } }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  };

  // Retention saves on its own (not bundled with the defaults autosave): the toggle persists
  // immediately, the days field commits on blur/Enter and reverts an invalid (< 1) draft.
  const saveRetention = async (next: { enabled?: boolean; days?: number }) => {
    try { await update.mutateAsync({ sessionRetention: next }); }
    catch { toast(t.settings.retention.saveError, 'error'); }
  };
  const commitRetentionDays = () => {
    const parsed = Math.floor(Number(retentionDaysDraft));
    if (!Number.isFinite(parsed) || parsed < 1) { setRetentionDaysDraft(String(retention.days)); return; }
    if (parsed !== retention.days) void saveRetention({ days: parsed });
  };

  // Auto-persist: every settings form saves itself shortly after a change (no Save buttons anywhere).
  // The apiKey secret rides along only when freshly typed, exactly as with the old buttons.
  const ready = seeded.current;
  const defaultsSave = useAutoSaveStatus([defTokenTtl], saveDefaults, { ready });
  // Per-model context windows auto-persist like every other model setting (no Save button).
  const windowsSave = useAutoSaveStatus([modelWindows], async () => {
    try { await update.mutateAsync({ brain: { modelContextWindows: modelWindows } }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  }, { ready });
  const modelsSave = useAutoSaveStatus([allowed, customModels, hiddenPresets, modelNotes], async () => {
    try { await update.mutateAsync({ allowedExecs: allowed, customModels, hiddenPresets, modelNotes }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  }, { ready, delay: 0 });
  const autoUpdateSave = useAutoSaveStatus([autoUpdate], async () => {
    try { await update.mutateAsync({ autoUpdate }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  }, { ready, delay: 0 });
  const pushContactSave = useAutoSaveStatus([pushContact], async () => {
    try { await update.mutateAsync({ webPushContact: pushContact }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  }, { ready });
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

  const resetForm = () => {
    setShowAddForm(false);
    setEditingExec(null);
  };

  // Model changes auto-persist immediately — no separate "save models" step to forget (a two-step
  // add-then-save was a footgun where edits silently vanished on reload). Each handler computes the
  // next state, applies it, and PUTs it in one go. Success is silent; only errors toast.
  const persistModels = (next: { allowed?: string[]; customModels?: { label: string; exec: string }[]; hiddenPresets?: string[]; modelNotes?: Record<string, string> }) => {
    const allowedExecs = next.allowed ?? allowed;
    const cm = next.customModels ?? customModels;
    const hp = next.hiddenPresets ?? hiddenPresets;
    const mn = next.modelNotes ?? modelNotes;
    setAllowed(allowedExecs);
    setCustomModels(cm);
    setHiddenPresets(hp);
    setModelNotes(mn);
  };

  // Persist a single model's model description (empty string clears the entry). Persist-only — the
  // modal auto-saves and owns its own close, so this must NOT dismiss it.
  const saveNote = (exec: string, note: string) => {
    const next = { ...modelNotes };
    if (note) next[exec] = note; else delete next[exec];
    persistModels({ modelNotes: next });
  };

  const toggle = (exec: string) =>
    persistModels({ allowed: allowed.includes(exec) ? allowed.filter((e) => e !== exec) : [...allowed, exec] });

  // Delete and edit go through the pure helpers so a custom override of a preset (which lives in BOTH
  // customModels and the preset list) is handled correctly — the old split-by-`PRESET_EXECS` logic
  // left the other half behind, so presets wouldn't delete and renames duplicated.
  const deleteModel = (exec: string) => {
    persistModels(removeModel({ allowed, customModels, hiddenPresets, modelNotes }, exec));
    if (editingExec === exec) resetForm();
  };

  const startEdit = (m: { label: string; exec: string }) => {
    setEditingExec(m.exec);
    setShowAddForm(true);
  };

  const saveModel = (m: { label: string; exec: string }) => {
    persistModels(upsertModel({ allowed, customModels, hiddenPresets, modelNotes }, m, editingExec ?? undefined));
    resetForm();
  };

  // 'models' auto-saves; 'data' is a one-off danger action; 'system'
  // auto-saves its toggle + has its own update button; 'plugins' toggles apply instantly — none of
  // these use the shared footer save button.

  const models = allModels(customModels, hiddenPresets);
  const visibleProviders = PROVIDERS.filter((provider) => provider.embedded);

  const deleteTarget = models.find((m) => m.exec === pendingDelete);
  // Providers the user has actually configured (non-empty binary; edited in the agents plugin's
  // CLI Agents deck) — the only ones offered when adding a model, and the source for the executor
  // picker's grouping.
  const configProviders = config.data?.providers ?? {};
  const activeProviders = PROVIDERS.filter((p) => (configProviders[p.id]?.bin ?? '').trim() !== '').map((p) => p.id as ProviderId);
  // Sections that report their own state (core panels and plugin-contributed ones alike) come straight
  // from the sink; the two whose state is assembled from several independent autosaves are folded here.
  const feedbackByCategory: Partial<Record<string, SaveFeedback>> = {
    ...sectionFeedback,
    models: combineSaveFeedback(modelsSave, windowsSave),
    system: combineSaveFeedback(autoUpdateSave, defaultsSave, pushContactSave),
  };
  const activeFeedback = feedbackByCategory[category] ?? { status: 'idle' as const };
  const sectionHints: Record<Category, string> = {
    models: t.settings.modelsSectionHint,
    brain: t.settings.brainSectionHint,
    memory: t.settings.memorySectionHint,
    plugins: t.settings.pluginsSectionHint,
    data: t.settings.dataSectionHint,
    system: t.settings.systemSectionHint,
  };
  // Core sections, in their fixed order. Plugins do not appear here: each owns a world in the main
  // navigation and its settings sections are pages of that world.
  const deckSections = SETTINGS_SECTIONS.map(({ id, icon }) => ({ id, icon, label: id === 'brain' ? agentAiLabel : t.settings[id], description: sectionHints[id] }));
  const diagnostics = system.data?.diagnostics;
  // The hero answers "is this instance healthy right now" on every settings tab, and carries the one
  // action an operator reaches for after changing something. Restarting still goes through the same
  // confirmation as the row in the System section — this is a second door to it, not a second path.
  const activeSection = deckSections.find((section) => section.id === category) ?? deckSections[0]!;
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
    metrics: category === 'system' ? (
      <>
        <WorkspaceMetric label={t.settings.version.replace('{productName}', brand.appName)} value={<span className="font-mono">{system.data?.version ?? '—'}</span>} icon={Sparkles} />
        <WorkspaceMetric label={t.settings.serviceDaemon} value={system.isError ? t.settings.serviceDown : t.settings.serviceUp} icon={Server} />
        <WorkspaceMetric label={t.settings.diagnosticMemory} value={diagnostics ? `${Math.round((diagnostics.memoryUsedBytes / diagnostics.memoryTotalBytes) * 100)} %` : '—'} icon={MemoryStick} />
        <WorkspaceMetric label={t.settings.diagnosticUptime} value={diagnostics ? formatUptime(diagnostics.uptimeSeconds) : '—'} icon={Timer} />
      </>
    ) : undefined,
  } satisfies WorkspaceHeroProps;

  return (
    <ModuleShell moduleId="settings">
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal} />

      <div className="flex w-full min-w-0 flex-col">
      <WorkspaceShell
        variant="deck"
        hero={deckHero}
        navigation={{ sections: deckSections, value: activeSection.id, onChange: setCategory, ariaLabel: t.settings.sectionsNav }}
      >
        <SettingsPanel id="models" active={category} visited={visitedCategories}>
          <>
            <SettingsToolbar>
              <div className="relative w-full">
                <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <Input
                  type="search"
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={t.settings.modelSearchPlaceholder}
                  aria-label={t.settings.modelSearchPlaceholder}
                  className="pl-9"
                />
              </div>
            </SettingsToolbar>
            {/* One catalog, grouped by the engine that runs the model — the same grouping the
             *  executor picker uses, so what admins configure here matches what users pick. */}
            {visibleProviders.map((prov) => {
              const needle = modelQuery.trim().toLocaleLowerCase();
              const allCliItems = models.filter((m) => execProvider(m.exec) === prov.id);
              const allElowenItems = prov.id === 'elowen' ? (brainModels.data ?? []) : [];
              const cliItems = needle ? allCliItems.filter((m) => `${prov.label} ${m.label} ${m.exec} ${execModel(m.exec)} ${modelNotes[m.exec] ?? ''}`.toLocaleLowerCase().includes(needle)) : allCliItems;
              const elowenItems = needle ? allElowenItems.filter((m) => `${prov.label} ${m.model} ${m.exec} ${m.providerLabel}`.toLocaleLowerCase().includes(needle)) : allElowenItems;
              if (cliItems.length === 0 && elowenItems.length === 0) return null;
              const groupExecs = [...allCliItems.map((m) => m.exec), ...allElowenItems.map((m) => m.exec)];
              const enabledCount = groupExecs.filter((e) => allowed.includes(e)).length;
              return (
                <SettingsGroup key={prov.id} density="compact">
                  <header className="settings-group__header">
                    <div className="settings-group__heading">
                      <ProviderLogo meta={prov} size={28} />
                      <div className="flex items-center gap-2">
                        <h2>{prov.label}</h2>
                        <span className="font-mono text-tiny text-text-muted">{enabledCount}/{groupExecs.length}</span>
                        {prov.embedded ? <HelpTip align="left">{t.help.elowenModels}</HelpTip> : null}
                      </div>
                    </div>
                  </header>
                  <div className="settings-model-rows @container">
                    {cliItems.map((p) => {
                      const isCustom = !isPresetExec(p.exec);
                      return (
                        <div data-testid="model-row" key={p.exec} className="settings-model-row settings-model-row--cli group flex min-w-0 items-center gap-3 transition-colors">
                          <span className="settings-model-row__icon flex h-9 w-9 shrink-0 items-center justify-center text-text-muted">
                            <ModelIcon name={p.exec} size={20} />
                          </span>
                          <div className="settings-model-row__identity min-w-0 @2xl:w-56 @2xl:shrink-0">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="truncate text-sm font-medium text-text">{p.label}</span>
                              {!isCustom ? <span className="text-[9px] uppercase tracking-wide text-text-muted/70">{t.settings.presetTag}</span> : null}
                            </div>
                            <span className="block truncate font-mono text-[11px] text-text-muted">{execModel(p.exec)}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setNoteFor({ label: p.label, exec: p.exec })}
                            title={t.settings.modelNoteEdit}
                            className={`hidden min-w-0 flex-1 truncate text-left text-xs @2xl:block ${modelNotes[p.exec]?.trim() ? 'text-text-muted hover:text-text' : 'italic text-text-muted/60 hover:text-text-muted'}`}
                          >
                            {modelNotes[p.exec]?.trim() || t.settings.modelNoteAdd}
                          </button>
                          <div className="settings-model-row__controls ml-auto flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              aria-label={t.settings.editLabel.replace('{exec}', p.exec)}
                              title={t.settings.editLabel.replace('{exec}', p.exec)}
                              onClick={() => startEdit(p)}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text"
                            >
                              <Pencil size={13} aria-hidden />
                            </button>
                            <button
                              type="button"
                              aria-label={t.settings.deleteLabel.replace('{exec}', p.exec)}
                              title={t.settings.deleteLabel.replace('{exec}', p.exec)}
                              onClick={() => setPendingDelete(p.exec)}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                            >
                              <X size={13} aria-hidden />
                            </button>
                            <Toggle checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} label={p.label} />
                          </div>
                        </div>
                      );
                    })}
                    {elowenItems.map((m) => {
                      const winKey = `${m.provider}/${m.model}`;
                      // Local state is the live truth for overrides (seeded from the same config
                      // `m.contextWindowSet` derives from, then autosaved), so a just-set or
                      // just-cleared override renders immediately without waiting for a refetch.
                      const override = modelWindows[winKey];
                      const overridden = override != null;
                      return (
                      <div data-testid="model-row" key={m.exec} className="settings-model-row settings-model-row--elowen flex min-w-0 items-center gap-3 transition-colors">
                          <span className="settings-model-row__icon flex h-9 w-9 shrink-0 items-center justify-center text-text-muted"><ModelIcon name={m.model} size={20} /></span>
                          <div className="settings-model-row__identity min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-text">{m.model}</span>
                            <span className="block truncate font-mono text-[11px] text-text-muted">{m.exec}</span>
                          </div>
                          <div className="settings-model-row__controls ml-auto flex shrink-0 items-center gap-2">
                            <span className="settings-model-row__provider min-w-0"><Badge>{m.providerLabel}</Badge></span>
                            <button
                              type="button"
                              onClick={() => setCtxFor({ model: m.model, key: winKey, effective: m.contextWindow })}
                              title={`${t.brain.contextWindowEdit} · ${formatTokens(override ?? m.contextWindow)}`}
                              aria-label={`${t.brain.contextWindowEdit}: ${m.model}`}
                              className={`settings-model-row__context inline-flex h-8 shrink-0 items-center gap-1 px-2 font-mono text-[11px] transition-colors ${overridden ? 'text-accent' : 'text-text-muted hover:text-text'}`}
                            >
                              <Gauge size={12} aria-hidden />
                              {formatTokens(override ?? m.contextWindow)}
                            </button>
                            <Toggle checked={allowed.includes(m.exec)} onChange={() => toggle(m.exec)} label={m.model} />
                          </div>
                      </div>
                      );
                    })}
                  </div>
                </SettingsGroup>
              );
            })}

            {modelQuery.trim() && ![

              ...(brainModels.data ?? []).map((m) => `${PROVIDERS.find((provider) => provider.id === 'elowen')?.label ?? ''} ${m.model} ${m.exec} ${m.providerLabel}`),
            ].some((value) => value.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())) ? (
              <SettingsState>{t.settings.modelNoMatches}</SettingsState>
            ) : null}

          </>
        </SettingsPanel>

        {showAddForm && (
          <ModelModal
            initial={editingExec ? models.find((m) => m.exec === editingExec) ?? null : null}
            existingExecs={new Set(models.map((m) => m.exec))}
            activeProviders={activeProviders}
            onClose={resetForm}
            onSave={saveModel}
          />
        )}

        {noteFor && (
          <ModelNoteModal
            label={noteFor.label}
            exec={noteFor.exec}
            initial={modelNotes[noteFor.exec] ?? ''}
            onClose={() => setNoteFor(null)}
            onSave={(note) => saveNote(noteFor.exec, note)}
          />
        )}

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
                        <button type="button" className="spatial-inline-action text-accent" disabled={systemUpdate.isPending} onClick={() => systemUpdate.mutate(undefined, {
                          onSuccess: () => toast(t.settings.updateStarted),
                          onError: (e) => toast(String(e), 'error'),
                        })}>{systemUpdate.isPending ? t.settings.updating : t.settings.updateNow}<RefreshCw size={13} className={systemUpdate.isPending ? 'animate-spin' : ''} aria-hidden /></button>
                      ) : null}
                    </>
                  )}
                />
              );
              {/* Reporting only. Both restarts live in the deck hero, where they are reachable from every
                  settings section instead of just this one — a second copy here would be two doors to the
                  same confirmation with no way to tell them apart. */}
              const serviceRows = [
                { name: t.settings.serviceDaemon, port: ':4400', up: !system.isError },
                { name: t.settings.serviceWeb, port: ':4500', up: true },
              ].map((service) => (
                <SettingsRow
                  key={service.port}
                  label={service.name}
                  status={<span className="font-mono">{service.port}</span>}
                  icon={Server}
                >
                  <span className={`settings-control-row__status ${service.up ? '' : 'settings-control-row__status--down'}`}><i aria-hidden />{service.up ? t.settings.serviceUp : t.settings.serviceDown}</span>
                </SettingsRow>
              ));
              const rowAutoUpdate = (
                <SettingsRow label={t.settings.autoUpdate} icon={RefreshCw}>
                  <Toggle checked={autoUpdate} onChange={setAutoUpdate} label={t.settings.autoUpdate} />
                </SettingsRow>
              );
              const rowPushContact = (
                <SettingsRow label={t.settings.pushContact} description={t.help.pushContact} icon={BellRing}>
                  <input value={pushContact} onChange={(e) => setPushContact(e.target.value)} placeholder={t.settings.pushContactPlaceholder} className={inputClass} aria-label={t.settings.pushContact} />
                </SettingsRow>
              );
              const rowTokenTtl = (
                <SettingsRow label={t.settings.tokenTtl} description={t.help.tokenTtl} icon={KeyRound}>
                  <input type="number" min={1} value={defTokenTtl} onChange={(e) => setDefTokenTtl(Number(e.target.value))} className={inputClass} aria-label={t.settings.tokenTtl} />
                </SettingsRow>
              );
              // The row stays minimal (toggle + the current threshold); the full composite lives
              // in the side drawer behind the manage button.
              const rowRetention = (
                <SettingsRow label={t.settings.retention.label} description={t.settings.retention.hint} icon={CalendarClock}>
                  <div className="flex items-center gap-3">
                    <Toggle checked={retention.enabled} onChange={(next) => void saveRetention({ enabled: next })} label={t.settings.retention.label} />
                    {retention.enabled ? <span className="whitespace-nowrap font-mono text-sm tabular-nums text-text">{retention.days} {t.settings.retention.days}</span> : null}
                    <button type="button" data-selection-manage className="spatial-inline-action" onClick={() => setRetentionOpen(true)}>
                      <CalendarClock size={14} aria-hidden />{t.managePicker.manage}
                    </button>
                  </div>
                </SettingsRow>
              );
              const retentionDrawer = retentionOpen ? (
                <WorkspaceDetailRail label={t.settings.retention.label} closeLabel={t.common.close} onClose={() => setRetentionOpen(false)}>
                  <p className="mb-4 text-xs leading-relaxed text-text-muted">{t.settings.retention.hint}</p>
                  <div className="flex flex-col gap-5 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-text">{t.settings.retention.label}</span>
                      <Toggle checked={retention.enabled} onChange={(next) => void saveRetention({ enabled: next })} label={t.settings.retention.label} />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.retention.olderThan}</span>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          value={retentionDaysDraft}
                          disabled={!retention.enabled}
                          onChange={(e) => setRetentionDaysDraft(e.target.value)}
                          onBlur={commitRetentionDays}
                          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                          className="w-24 text-center"
                          aria-label={t.settings.retention.olderThan}
                        />
                        <span className="text-xs text-text-muted">{t.settings.retention.days}</span>
                      </div>
                    </div>
                  </div>
                </WorkspaceDetailRail>
              ) : null;
              const diagnosticsGroup = (
                <SettingsGroup title={t.settings.systemDiagnostics} description={t.settings.systemSectionHint} icon={Gauge} className="settings-diagnostics">
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
                  {retentionDrawer}
                </div>
              );
            })()}
          
        </SettingsPanel>

        <SettingsPanel id="brain" active={category} visited={visitedCategories}>
          
            {/* Cross-link to the model catalog (enable / context-window per model) — the Models section. */}
            <SettingsToolbar promote={false}>
              <button type="button" onClick={() => setCategory('models')} className="font-medium text-accent hover:underline">
                {t.settings.brainModelsLink}
              </button>
            </SettingsToolbar>
            <BrainSection onSaveState={reportSaveState} />
          
        </SettingsPanel>

        <SettingsPanel id="memory" active={category} visited={visitedCategories}>
          <MemorySection onSaveState={reportSaveState} />
        </SettingsPanel>

        <SettingsPanel id="plugins" active={category} visited={visitedCategories}><PluginsSection /></SettingsPanel>

        <SettingsPanel id="data" active={category} visited={visitedCategories}>
          {/* Header only, like the log viewer below it: the capture switch and the sensitivity notice
              belong to the viewer itself, where they have context, not to a settings row nobody reads. */}
          <SettingsGroup
            title={t.settings.conversationDiagnostics.title}
            icon={MessageSquareText}
            actions={<Button icon={MessageSquareText} onClick={() => setConversationDiagnosticsOpen(true)}>{t.settings.conversationDiagnostics.open}</Button>}
          />
          {/* Header only. The directory and the per-file breakdown are one click away in the viewer, so
              repeating them here bought a row between two sections and nothing else. */}
          <SettingsGroup
            title={logFiles.data
              ? `${t.settings.logs} · ${formatBytes(logFiles.data.files.reduce((sum, f) => sum + f.bytes, 0))}`
              : t.settings.logs}
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
          onEnableCapture={() => update.mutate({ runtime: { providerRequestCaptureEnabled: true } })}
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

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.settings.deleteModel}
        description={deleteTarget ? t.settings.deleteModelDesc.replace('{label}', deleteTarget.label).replace('{exec}', deleteTarget.exec) : undefined}
        confirmLabel={t.common.delete}
        onConfirm={() => {
          if (pendingDelete) deleteModel(pendingDelete);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />

    </ModuleShell>
  );
}
