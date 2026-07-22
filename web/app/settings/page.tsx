'use client';
export const dynamic = 'force-dynamic';
import { Activity, useCallback, useEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import { Bot, SlidersHorizontal, Plus, X, Pencil, Radio, Cpu, Gauge, Layers, Link2, KeyRound, FileText, Eye, Lock, Trash2, GitPullRequest, GitBranch, TerminalSquare, RefreshCw, RotateCcw, Sparkles, FlaskConical, Search, Server, CalendarClock } from 'lucide-react';
import { PROVIDERS, ProviderLogo } from '../../modules/settings/providers';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { BackendPicker } from '../../components/ui/BackendPicker';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ModelCatalogField } from '../../components/ui/ModelCatalogField';
import { ModelModal } from '../../modules/settings/ModelModal';
import { ModelNoteModal } from '../../modules/settings/ModelNoteModal';
import { ContextWindowModal } from '../../modules/settings/ContextWindowModal';
import { GithubStatusBanner } from '../../modules/settings/GithubStatusBanner';
import { PluginsSection } from '../../modules/settings/PluginsSection';
import { BrainSection } from '../../modules/settings/BrainSection';
import { MemorySection } from '../../modules/settings/MemorySection';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { execProvider, execModel, type ProviderId } from '../../lib/modelProvider';
import { formatTokens } from '../../lib/format';
import { useBrainModels, useConfig, useMe, useSystem, useSystemSkills } from '../../lib/queries';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback, type SaveFeedback } from '../../lib/saveFeedback';
import { useUpdateConfig, useCleanupAll, useSystemUpdate, useSystemRestart, useInstallSkills } from '../../lib/mutations';
import { ElowenApiError } from '../../lib/elowenClient';
import { allModels, isPresetExec, removeModel, upsertModel } from '../../lib/execPresets';
import { usePersistentState } from '../../lib/usePersistentState';
import { useSearchParams } from 'next/navigation';
import { SETTINGS_CATEGORY_VALUES, SETTINGS_SECTIONS, type SettingsCategory } from '../../modules/settings/categories';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SpatialControlDeck } from '../../components/ui/SpatialControlDeck';
import { SettingsDocument, SettingsGroup, SettingsRow, SettingsToolbar, SettingsState } from '../../modules/settings/SettingsSurface';
import { MotionReveal } from '../../components/ui/Motion';
import { ConstellationScope } from '../../components/ui/Constellation';
import { WorkspaceDetailRail } from '../../components/ui/WorkspacePrimitives';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';
import { useTranslation } from '../../lib/i18n';

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

/** Relay-mode model field: a free-text model name with a live brand badge, mirroring
 *  BackendPicker's icon affordance so both autopilot modes look consistent. */
function ModelInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg" aria-hidden>
        <ModelIcon name={value} size={16} />
      </span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} placeholder={placeholder} />
    </div>
  );
}

const CATEGORY_VALUES = SETTINGS_CATEGORY_VALUES;
type Category = SettingsCategory;

/** PROTOTYPE(constellation): per-category rollout of the orbital layout (mirrors
 *  ACCOUNT_CONSTELLATION in the account view). A category set to true renders its rows as an
 *  orbital field with drawers and drops the document card frame; flip to false to restore the
 *  classic layout — no other change needed. The deck is compact like Account (no hero band); the
 *  version/update/restart controls the hero used to carry live in the System section. */
const SETTINGS_CONSTELLATION: Partial<Record<Category, boolean>> = { memory: true, github: true, autopilot: true, brain: true, system: true };

/** Keep a settings document alive after its first visit without eagerly mounting every category's
 *  data hooks. React Activity retains form/search state and pauses effects while a panel is hidden. */
function SettingsPanel({ id, active, visited, children }: {
  id: Category;
  active: Category;
  visited: ReadonlySet<Category>;
  children: ReactNode;
}) {
  if (id !== active && !visited.has(id)) return null;
  return (
    <Activity mode={id === active ? 'visible' : 'hidden'}>
      <MotionReveal data-settings-panel={id} data-constellation={SETTINGS_CONSTELLATION[id] ? '' : undefined}>
        <SettingsDocument>{children}</SettingsDocument>
      </MotionReveal>
    </Activity>
  );
}

/** Wraps a category's content in a ConstellationScope when its flag is on. */
function SettingsScope({ id, core, children }: { id: Category; core: string; children: ReactNode }) {
  return SETTINGS_CONSTELLATION[id] ? <ConstellationScope core={core}>{children}</ConstellationScope> : <>{children}</>;
}

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const system = useSystem();
  const systemUpdate = useSystemUpdate();
  const systemRestart = useSystemRestart();
  const systemSkills = useSystemSkills();
  const installSkills = useInstallSkills();
  const cleanup = useCleanupAll();
  const me = useMe();
  const brainModels = useBrainModels();
  const { toast } = useToast();
  const { t } = useTranslation();
  // Drives the "delete all data" confirm dialog (Data section).
  const [cleanupOpen, setCleanupOpen] = useState(false);
  // Which service the "restart?" confirm dialog is asking about (null = closed).
  const [restartTarget, setRestartTarget] = useState<'daemon' | 'web' | null>(null);

  // Active section — a real state (remembered in localStorage across F5) kept in step with the URL
  // `?cat=<section>`. Switching flips the state directly (so the view changes instantly) AND rewrites
  // the URL (so F5 / share / the sidebar highlight agree).
  const searchParams = useSearchParams();
  const [category, setCategoryState] = usePersistentState<Category>('elowen.settings.category', 'system', CATEGORY_VALUES);
  const [visitedCategories, setVisitedCategories] = useState<Set<Category>>(() => new Set([category]));
  const [sectionFeedback, setSectionFeedback] = useState<Partial<Record<Category, SaveFeedback>>>({});
  const reportSaveState = useCallback((id: string, status: SaveStatus, retry?: () => void) => {
    if (!(CATEGORY_VALUES as readonly string[]).includes(id)) return;
    setSectionFeedback((current) => ({ ...current, [id as Category]: { status, retry } }));
  }, []);
  useEffect(() => {
    setVisitedCategories((current) => current.has(category) ? current : new Set(current).add(category));
  }, [category]);
  const isValidCat = (c: string | null): c is Category => !!c && (CATEGORY_VALUES as readonly string[]).includes(c);
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
  const setCategory = (next: Category) => {
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
  // The model whose autopilot description is being edited (null = editor closed).
  const [noteFor, setNoteFor] = useState<{ label: string; exec: string } | null>(null);
  // The Elowen AI model whose context-window override is being edited (null = editor closed).
  const [ctxFor, setCtxFor] = useState<{ model: string; key: string; effective: number } | null>(null);
  const [model, setModel] = useState('');
  const [overseerModel, setOverseerModel] = useState('');
  const [pilotExec, setPilotExec] = useState('');
  const [overseerExec, setOverseerExec] = useState('');
  // Autopilot backend is an either/or: 'relay' (planner+overseer via API) or 'agents' (CLI agents
  // that read the repo). Derived from whether an exec is set; the picker enforces the exclusivity.
  const [reasoningMode, setReasoningMode] = useState<'relay' | 'agents'>('relay');
  const [reviewOnDone, setReviewOnDone] = useState(false);
  const [tddMode, setTddMode] = useState(false);
  const [prEnabled, setPrEnabled] = useState(false);
  const [prBaseBranch, setPrBaseBranch] = useState('');
  const [prAutoOpen, setPrAutoOpen] = useState(false);
  const [prVerifyCommand, setPrVerifyCommand] = useState('');
  const [ghToken, setGhToken] = useState('');
  // PROTOTYPE(constellation): the GitHub text fields edit in one side drawer opened via pod orbs.
  const [githubOpen, setGithubOpen] = useState(false);
  // PROTOTYPE(constellation): same pattern for the Autopilot free-text fields (models/endpoint/notes).
  const [autopilotOpen, setAutopilotOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  // When set, the planner/overseer/curator reuse this brain provider's endpoint+key instead of a
  // separately-entered relay key — so a key is never typed twice. Empty = the legacy manual apiUrl/apiKey.
  const [apProviderId, setApProviderId] = useState('');
  // Model catalog scoped to the picked autopilot provider — feeds the planner/overseer model pills (like
  // Settings → Memory). Empty in Manual mode: no catalog for an arbitrary endpoint, so a free-text input runs.
  const apCatalog = useMemo(
    () => Array.from(new Set((brainModels.data ?? []).filter((m) => m.provider === apProviderId).map((m) => m.model))),
    [brainModels.data, apProviderId],
  );
  const [notes, setNotes] = useState('');
  const [providers, setProviders] = useState<Record<string, { bin: string; args: string; skipPermissions?: boolean; resume?: boolean }>>({});
  const [defExec, setDefExec] = useState('');
  const [defAutonomy, setDefAutonomy] = useState('');
  const [defMaxSessions, setDefMaxSessions] = useState(1);
  const [defTokenTtl, setDefTokenTtl] = useState(30);
  const [autoUpdate, setAutoUpdate] = useState(false);

  // Conversation auto-cleanup: the daemon's hourly janitor deletes idle conversations older than N
  // days. Off by default; it never touches running/active/channel sessions. Saved immediately
  // (toggle) or on blur/Enter (days), clamped to >= 1, reverting an invalid draft. Persists
  // independently of the token-TTL defaults autosave.
  const retention = config.data?.sessionRetention ?? { enabled: false, days: 90 };
  const [retentionDaysDraft, setRetentionDaysDraft] = useState('');

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
      setModel(config.data.autopilot.model);
      setOverseerModel(config.data.autopilot.overseerModel ?? '');
      setPilotExec(config.data.autopilot.pilotExec ?? '');
      setOverseerExec(config.data.autopilot.overseerExec ?? '');
      setReviewOnDone(config.data.autopilot.reviewOnDone ?? false);
      setTddMode(config.data.autopilot.tddMode ?? false);
      setPrEnabled(config.data.autopilot.prEnabled ?? false);
      setPrBaseBranch(config.data.autopilot.prBaseBranch ?? '');
      setPrAutoOpen(config.data.autopilot.prAutoOpen ?? false);
      setPrVerifyCommand(config.data.autopilot.prVerifyCommand ?? '');
      setReasoningMode((config.data.autopilot.pilotExec || config.data.autopilot.overseerExec) ? 'agents' : 'relay');
      setApiUrl(config.data.autopilot.apiUrl);
      setApProviderId(config.data.autopilot.providerId ?? '');
      setNotes(config.data.autopilot.notes);
      setProviders(config.data.providers ?? {});
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
      setDefTokenTtl(config.data.security?.tokenTtlDays ?? 30);
      setAutoUpdate(config.data.autoUpdate ?? false);
    }
  }, [config.data]);

  // The retention days field tracks the stored value directly (not the one-shot seed above), so an
  // external change is reflected and an invalid draft can revert to the saved number.
  useEffect(() => { setRetentionDaysDraft(String(retention.days)); }, [retention.days]);

  // Persist only the active mode's fields, and explicitly clear the other backend so the two never
  // coexist (relay clears the execs; agents leave the relay model/key untouched but unused).
  const saveAutopilot = async () => {
    try {
      await update.mutateAsync({ autopilot: reasoningMode === 'agents'
        ? { pilotExec, overseerExec, reviewOnDone, tddMode, notes }
        : { model, overseerModel, apiUrl, providerId: apProviderId, pilotExec: '', overseerExec: '', tddMode, notes, ...(apiKey ? { apiKey } : {}) } });
      if (apiKey) setApiKey('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };

  // GitHub / PR-native settings live in their own section. The global prEnabled is the DEFAULT for new
  // projects; each project can override it. The ghToken is write-only — sent only when freshly typed.
  const saveGithub = async () => {
    try {
      await update.mutateAsync({ autopilot: { prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ...(ghToken ? { ghToken } : {}) } });
      if (ghToken) setGhToken('');
    } catch (error) { toast(String(error), 'error'); throw error; }
  };

  const saveProviders = async () => {
    try { await update.mutateAsync({ providers }); }
    catch (error) { toast(String(error), 'error'); throw error; }
  };

  // autoUpdate is NOT bundled here — the System toggle is its single writer (it persists inline).
  const saveDefaults = async () => {
    try { await update.mutateAsync({ defaults: { exec: defExec, autonomy: defAutonomy, maxSessions: defMaxSessions }, security: { tokenTtlDays: defTokenTtl } }); }
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
  // Secrets (apiKey/ghToken) ride along only when freshly typed, exactly as with the old buttons.
  const ready = seeded.current;
  const autopilotSave = useAutoSaveStatus([reasoningMode, pilotExec, overseerExec, reviewOnDone, tddMode, notes, model, overseerModel, apiUrl, apiKey, apProviderId], saveAutopilot, { ready });
  const githubSave = useAutoSaveStatus([prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ghToken], saveGithub, { ready });
  const providersSave = useAutoSaveStatus([providers], saveProviders, { ready });
  const defaultsSave = useAutoSaveStatus([defExec, defAutonomy, defMaxSessions, defTokenTtl], saveDefaults, { ready });
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

  const apiKeySet = config.data?.autopilot.apiKeySet;
  const ghTokenSet = config.data?.autopilot.ghTokenSet;

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

  // Persist a single model's autopilot description (empty string clears the entry). Persist-only — the
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

  // Switch the autopilot backend mode. Relay clears the agent execs; agents seed a default model so
  // the mode can't silently collapse back to relay (an empty exec = relay).
  const switchReasoning = (m: 'relay' | 'agents') => {
    setReasoningMode(m);
    if (m === 'relay') { setPilotExec(''); setOverseerExec(''); }
    else {
      const def = models[0]?.exec ?? '';
      if (!pilotExec) setPilotExec(def);
      if (!overseerExec) setOverseerExec(def);
    }
  };
  const deleteTarget = models.find((m) => m.exec === pendingDelete);
  // Providers the user has actually configured (non-empty binary) — the only ones offered when
  // adding a model, and the source for the executor picker's grouping.
  const activeProviders = PROVIDERS.filter((p) => (providers[p.id]?.bin ?? '').trim() !== '').map((p) => p.id as ProviderId);
  const feedbackByCategory: Partial<Record<Category, SaveFeedback>> = {
    models: combineSaveFeedback(modelsSave, windowsSave),
    providers: providersSave,
    autopilot: combineSaveFeedback(autopilotSave, defaultsSave),
    github: githubSave,
    system: combineSaveFeedback(autoUpdateSave, defaultsSave),
    brain: sectionFeedback.brain,
    memory: sectionFeedback.memory,
    plugins: sectionFeedback.plugins,
  };
  const activeFeedback = feedbackByCategory[category] ?? { status: 'idle' as const };
  const sectionHints: Record<Category, string> = {
    models: t.settings.modelsSectionHint,
    providers: t.settings.providersSectionHint,
    brain: t.settings.brainSectionHint,
    memory: t.settings.memorySectionHint,
    plugins: t.settings.pluginsSectionHint,
    autopilot: t.settings.autopilotSectionHint,
    github: t.settings.githubSectionHint,
    data: t.settings.dataSectionHint,
    system: t.settings.systemSectionHint,
  };
  const deckSections = SETTINGS_SECTIONS.map(({ id, icon }) => ({ id, icon, label: t.settings[id], description: sectionHints[id] }));
  const diagnostics = system.data?.diagnostics;

  return (
    <ModuleShell moduleId="settings">
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal} />

      <div className="flex w-full min-w-0 flex-col">
      <SpatialControlDeck
        eyebrow={t.page.settings}
        ariaLabel={t.settings.sectionsNav}
        sections={deckSections}
        value={category}
        onChange={(value) => setCategory(value as Category)}
        status={activeFeedback.status}
        onRetry={activeFeedback.retry}
        compact
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
            {PROVIDERS.map((prov) => {
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
                        <div data-testid="model-row" key={p.exec} className="settings-model-row group flex min-w-0 items-center gap-3 transition-colors">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center text-text-muted">
                            <ModelIcon name={p.exec} size={20} />
                          </span>
                          <div className="min-w-0 @2xl:w-56 @2xl:shrink-0">
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
                          <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                      <div data-testid="model-row" key={m.exec} className="settings-model-row flex min-w-0 items-center gap-3 transition-colors">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center text-text-muted"><ModelIcon name={m.model} size={20} /></span>
                          <div className="min-w-0 flex-1">
                            <span className="truncate text-sm font-medium text-text">{m.model}</span>
                            <span className="block truncate font-mono text-[11px] text-text-muted">{m.exec}</span>
                          </div>
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            <Badge>{m.providerLabel}</Badge>
                            <button
                              type="button"
                              onClick={() => setCtxFor({ model: m.model, key: winKey, effective: m.contextWindow })}
                              title={`${t.brain.contextWindowEdit} · ${formatTokens(override ?? m.contextWindow)}`}
                              aria-label={`${t.brain.contextWindowEdit}: ${m.model}`}
                              className={`inline-flex h-8 shrink-0 items-center gap-1 px-2 font-mono text-[11px] transition-colors ${overridden ? 'text-accent' : 'text-text-muted hover:text-text'}`}
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
              ...models.map((m) => `${PROVIDERS.find((provider) => provider.id === execProvider(m.exec))?.label ?? ''} ${m.label} ${m.exec} ${execModel(m.exec)} ${modelNotes[m.exec] ?? ''}`),
              ...(brainModels.data ?? []).map((m) => `${PROVIDERS.find((provider) => provider.id === 'elowen')?.label ?? ''} ${m.model} ${m.exec} ${m.providerLabel}`),
            ].some((value) => value.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())) ? (
              <SettingsState>{t.settings.modelNoMatches}</SettingsState>
            ) : null}

            <div className="settings-document__footer">
              <Button variant="ghost" icon={Plus} onClick={() => { setEditingExec(null); setShowAddForm(true); }}>
                {t.settings.addModel}
              </Button>
            </div>
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

        <SettingsPanel id="autopilot" active={category} visited={visitedCategories}>
          <SettingsScope id="autopilot" core={t.settings.autopilot}>
            {(() => {
              // PROTOTYPE(constellation): the same rows feed both layouts — one merged orbit in
              // cosmos mode (free-text fields become chips editing in one shared drawer), the
              // original three groups in the classic layout.
              const ap = SETTINGS_CONSTELLATION.autopilot;
              const apProviders = (config.data?.brain?.providers ?? []).filter((p) => p.apiKeySet).map((p) => ({ id: p.id, label: p.label }));
              const openDrawer = (label: string) => (
                <button type="button" data-selection-manage className="hidden" aria-label={label} onClick={() => setAutopilotOpen(true)} />
              );
              const drawerField = (label: string, control: ReactNode) => (
                <div className="flex flex-col gap-1.5">
                  <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{label}</span>
                  {control}
                </div>
              );
              // One clear choice: how the planner + overseer reason. Relay (API) OR CLI agents.
              const rowMode = (
                <SettingsRow label={t.settings.backendMode} description={t.help.backendMode} icon={Radio}>
                  <div className="flex flex-col gap-2">
                    <Segmented
                      value={reasoningMode}
                      onChange={(v) => switchReasoning(v as 'relay' | 'agents')}
                      options={[
                        { value: 'relay', label: t.settings.modeRelay, icon: Radio },
                        { value: 'agents', label: t.settings.modeAgents, icon: Bot },
                      ]}
                    />
                    {ap ? null : <p className="text-xs text-text-muted">{reasoningMode === 'relay' ? t.settings.modeRelayDesc : t.settings.modeAgentsDesc}</p>}
                  </div>
                </SettingsRow>
              );
              // In pods a many-provider Segmented strip grows too tall — pick as a chip + drawer.
              const rowApProvider = (
                <SettingsRow label={t.settings.apProvider} description={t.help.apProvider} icon={KeyRound}>
                  {ap && apProviders.length > 0
                    ? <ChoiceField title={t.settings.apProvider} options={apProviders.map((p) => ({ value: p.id, label: p.label }))} value={apProviderId} onChange={setApProviderId} picker="always" />
                    : <ProviderPicker providers={apProviders} value={apProviderId} onChange={setApProviderId} label={t.settings.apProvider} emptyText={t.settings.apNoProviders} />}
                </SettingsRow>
              );
              const relayHasCatalog = apProviderId !== '' && apCatalog.length > 0;
              const relayModelChip = (value: string, label: string) => (
                <>
                  <span className="flex min-w-0 items-center gap-2 font-mono text-sm text-text-muted">
                    <ModelIcon name={value} size={14} />
                    <span className="truncate">{value || '—'}</span>
                  </span>
                  {openDrawer(label)}
                </>
              );
              const rowPlannerRelay = (
                <SettingsRow label={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                  {relayHasCatalog
                    ? <ModelCatalogField value={model} onChange={setModel} catalog={apCatalog} title={t.settings.plannerModel} subtitle={t.help.plannerModel} />
                    : ap ? relayModelChip(model, t.settings.plannerModel)
                    : <ModelInput value={model} onChange={setModel} placeholder={t.settings.plannerPlaceholder} />}
                </SettingsRow>
              );
              const rowOverseerRelay = (
                <SettingsRow label={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                  {relayHasCatalog
                    ? <ModelCatalogField value={overseerModel} onChange={setOverseerModel} catalog={apCatalog} title={t.settings.overseerModel} subtitle={t.help.overseerModel} />
                    : ap ? relayModelChip(overseerModel, t.settings.overseerModel)
                    : <ModelInput value={overseerModel} onChange={setOverseerModel} placeholder={t.settings.overseerPlaceholder} />}
                </SettingsRow>
              );
              const apiUrlInput = <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} aria-label={t.settings.apiUrl} />;
              const apiKeyInput = <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? t.settings.apiKeySetPlaceholder : t.settings.apiKeyPlaceholder} className={inputClass} aria-label={t.settings.apiKey} />;
              // No provider picked → enter an endpoint + key directly. A chosen provider supplies both,
              // so these fields simply don't render (no redundant "inherited" note).
              const rowApiUrl = (
                <SettingsRow label={t.settings.apiUrl} description={t.help.apiUrl} icon={Link2}>
                  {ap ? <><span className="max-w-full truncate font-mono text-sm text-text-muted">{apiUrl || '—'}</span>{openDrawer(t.settings.apiUrl)}</> : apiUrlInput}
                </SettingsRow>
              );
              const rowApiKey = (
                <SettingsRow label={t.settings.apiKey} description={apiKeySet ? t.help.apiKey : t.help.apiKeyNotSet} icon={KeyRound}>
                  {ap ? <><span className="font-mono text-sm tracking-widest text-text-muted">{apiKeySet || apiKey ? '••••••••' : '—'}</span>{openDrawer(t.settings.apiKey)}</> : apiKeyInput}
                </SettingsRow>
              );
              const rowPlannerAgents = (
                <SettingsRow label={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                  <BackendPicker value={pilotExec} onChange={setPilotExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                </SettingsRow>
              );
              const rowOverseerAgents = (
                <SettingsRow label={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                  <BackendPicker value={overseerExec} onChange={setOverseerExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                </SettingsRow>
              );
              const rowReviewOnDone = (
                <SettingsRow label={t.settings.reviewOnDone} description={t.help.reviewOnDone} icon={Eye}>
                  <Toggle checked={reviewOnDone} onChange={setReviewOnDone} label={t.settings.reviewOnDone} />
                </SettingsRow>
              );
              const notesTextarea = <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} aria-label={t.settings.notes} />;
              const rowNotes = (
                <SettingsRow label={t.settings.notes} description={t.help.notes} icon={FileText}>
                  {ap ? <><span className="block max-w-full truncate text-sm text-text-muted">{notes.trim() || '—'}</span>{openDrawer(t.settings.notes)}</> : notesTextarea}
                </SettingsRow>
              );
              const rowExecutor = (
                <SettingsRow label={t.settings.executor} description={t.help.executor} icon={Cpu}>
                  {/* Same worker + Elowen AI split the task picker uses, in the unified manage-selection
                      modal, so the default executor can also be a brain model. A saved value missing
                      from the catalog stays selectable as a pinned row. */}
                  <BackendPicker value={defExec} onChange={setDefExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                </SettingsRow>
              );
              const rowAutonomy = (
                <SettingsRow label={t.settings.autonomy} description={t.help.autonomy} icon={Gauge}>
                  <div>
                  <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
                  {ap ? null : (
                    <p className="mt-2 text-xs leading-relaxed text-text-muted">
                      {({ L0: t.missions.autonomyL0Desc, L1: t.missions.autonomyL1Desc, L2: t.missions.autonomyL2Desc, L3: t.missions.autonomyL3Desc } as Record<string, string>)[defAutonomy]}
                    </p>
                  )}
                  </div>
                </SettingsRow>
              );
              const rowMaxSessions = (
                <SettingsRow label={t.settings.maxSessions} description={t.help.maxSessions} icon={Layers}>
                  <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} aria-label={t.settings.maxSessions} />
                </SettingsRow>
              );
              // TDD mission mode applies to every worker (standalone, mission phase, embedded) regardless
              // of the relay/agents split, so it lives with the run defaults — persisted via saveAutopilot.
              const rowTdd = (
                <SettingsRow label={t.settings.tddMode} description={t.help.tddMode} icon={FlaskConical}>
                  <Toggle checked={tddMode} onChange={setTddMode} label={t.settings.tddMode} />
                </SettingsRow>
              );
              const relayRows = (
                <>
                  {rowApProvider}
                  {rowPlannerRelay}
                  {rowOverseerRelay}
                  {apProviderId === '' ? <>{rowApiUrl}{rowApiKey}</> : null}
                </>
              );
              const agentRows = <>{rowPlannerAgents}{rowOverseerAgents}{rowReviewOnDone}</>;
              const drawer = ap && autopilotOpen ? (
                <WorkspaceDetailRail label={t.settings.autopilot} closeLabel={t.common.close} onClose={() => setAutopilotOpen(false)}>
                  <div className="flex flex-col gap-5 py-2">
                    {reasoningMode === 'relay' && !relayHasCatalog ? (
                      <>
                        {drawerField(t.settings.plannerModel, <ModelInput value={model} onChange={setModel} placeholder={t.settings.plannerPlaceholder} />)}
                        {drawerField(t.settings.overseerModel, <ModelInput value={overseerModel} onChange={setOverseerModel} placeholder={t.settings.overseerPlaceholder} />)}
                      </>
                    ) : null}
                    {reasoningMode === 'relay' && apProviderId === '' ? (
                      <>
                        {drawerField(t.settings.apiUrl, apiUrlInput)}
                        {drawerField(t.settings.apiKey, apiKeyInput)}
                      </>
                    ) : null}
                    {drawerField(t.settings.notes, notesTextarea)}
                  </div>
                </WorkspaceDetailRail>
              ) : null;
              return ap ? (
                <>
                  <SettingsGroup>
                    {rowMode}
                    {reasoningMode === 'relay' ? relayRows : agentRows}
                    {rowNotes}
                    {rowExecutor}
                    {rowAutonomy}
                    {rowMaxSessions}
                    {rowTdd}
                  </SettingsGroup>
                  {drawer}
                </>
              ) : (
                <div className="flex flex-col gap-4">
                  <SettingsGroup>{rowMode}</SettingsGroup>
                  <SettingsGroup>
                    {reasoningMode === 'relay' ? relayRows : agentRows}
                    {rowNotes}
                  </SettingsGroup>
                  {/* Default mission run — what the pilot actually launches: the worker executor, the
                      autonomy level and how many agents run in parallel. These apply in both reasoning
                      modes, so they live below the relay/agents split. */}
                  <SettingsGroup title={t.settings.runDefaults} icon={Cpu}>
                    {rowExecutor}
                    {rowAutonomy}
                    {rowMaxSessions}
                    {rowTdd}
                  </SettingsGroup>
                </div>
              );
            })()}
          </SettingsScope>
        </SettingsPanel>

        <SettingsPanel id="github" active={category} visited={visitedCategories}>
          <SettingsScope id="github" core={t.settings.github}>
            {/* variant="classic": the status banner is not a label/control row. */}
            <SettingsGroup variant="classic"><GithubStatusBanner /></SettingsGroup>
            <SettingsGroup>
            {/* PROTOTYPE(constellation): the three text fields show as chips in the orbit and edit
                together in one side drawer (opened via any of their pod orbs); toggles stay inline. */}
            <SettingsRow label={t.settings.ghToken} description={ghTokenSet ? t.help.ghToken : t.help.ghTokenNotSet} icon={KeyRound}>
              {SETTINGS_CONSTELLATION.github ? (
                <>
                  <span className="font-mono text-sm tracking-widest text-text-muted">{ghTokenSet || ghToken ? '••••••••' : '—'}</span>
                  <button type="button" data-selection-manage className="hidden" aria-label={t.settings.ghToken} onClick={() => setGithubOpen(true)} />
                </>
              ) : (
                <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? t.settings.apiKeySetPlaceholder : t.settings.ghTokenPlaceholder} className={inputClass} />
              )}
            </SettingsRow>
            <SettingsRow label={t.settings.prEnabled} description={t.help.prEnabled} icon={GitPullRequest}>
              <Toggle checked={prEnabled} onChange={setPrEnabled} label={t.settings.prEnabled} />
            </SettingsRow>
            <SettingsRow label={t.settings.prBaseBranch} description={t.help.prBaseBranch} icon={GitBranch}>
              {SETTINGS_CONSTELLATION.github ? (
                <>
                  <span className="max-w-full truncate font-mono text-sm text-text-muted">{prBaseBranch || t.settings.prBaseBranchPlaceholder}</span>
                  <button type="button" data-selection-manage className="hidden" aria-label={t.settings.prBaseBranch} onClick={() => setGithubOpen(true)} />
                </>
              ) : (
                <input value={prBaseBranch} onChange={(e) => setPrBaseBranch(e.target.value)} placeholder={t.settings.prBaseBranchPlaceholder} className={inputClass} />
              )}
            </SettingsRow>
            <SettingsRow label={t.settings.prAutoOpen} description={t.help.prAutoOpen} icon={GitPullRequest}>
              <Toggle checked={prAutoOpen} onChange={setPrAutoOpen} label={t.settings.prAutoOpen} />
            </SettingsRow>
            <SettingsRow label={t.settings.prVerifyCommand} description={t.help.prVerifyCommand} icon={TerminalSquare}>
              {SETTINGS_CONSTELLATION.github ? (
                <>
                  <span className="max-w-full truncate font-mono text-sm text-text-muted">{prVerifyCommand || '—'}</span>
                  <button type="button" data-selection-manage className="hidden" aria-label={t.settings.prVerifyCommand} onClick={() => setGithubOpen(true)} />
                </>
              ) : (
                <input value={prVerifyCommand} onChange={(e) => setPrVerifyCommand(e.target.value)} placeholder={t.settings.prVerifyCommandPlaceholder} className={`${inputClass} font-mono text-xs`} />
              )}
            </SettingsRow>
            </SettingsGroup>
            {SETTINGS_CONSTELLATION.github && githubOpen ? (
              <WorkspaceDetailRail label={t.settings.github} closeLabel={t.common.close} onClose={() => setGithubOpen(false)}>
                <div className="flex flex-col gap-5 py-2">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.ghToken}</span>
                    <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? t.settings.apiKeySetPlaceholder : t.settings.ghTokenPlaceholder} className={inputClass} aria-label={t.settings.ghToken} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.prBaseBranch}</span>
                    <input value={prBaseBranch} onChange={(e) => setPrBaseBranch(e.target.value)} placeholder={t.settings.prBaseBranchPlaceholder} className={inputClass} aria-label={t.settings.prBaseBranch} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-tiny font-semibold uppercase tracking-wide text-text-muted">{t.settings.prVerifyCommand}</span>
                    <input value={prVerifyCommand} onChange={(e) => setPrVerifyCommand(e.target.value)} placeholder={t.settings.prVerifyCommandPlaceholder} className={`${inputClass} font-mono text-xs`} aria-label={t.settings.prVerifyCommand} />
                  </div>
                </div>
              </WorkspaceDetailRail>
            ) : null}
          </SettingsScope>
        </SettingsPanel>

        <SettingsPanel id="providers" active={category} visited={visitedCategories}>
          <>
            {/* Agent skills sit at the top of CLI Agents — they install/verify the `elowen-workflow`
                skill into the very CLI agents this section configures. The daemon self-installs on
                startup; this is the on-demand re-apply + per-provider status. */}
            <SettingsGroup
              title={t.settings.agentSkills}
              description={t.help.agentSkills}
              icon={Sparkles}
              actions={<Button
                  variant="accent"
                  className="h-8 shrink-0"
                  disabled={installSkills.isPending || !(systemSkills.data?.skills ?? []).some((s) => s.present && !s.upToDate)}
                  onClick={() => installSkills.mutate(undefined, {
                    onSuccess: () => toast(t.settings.skillsInstalled),
                    onError: (e) => toast(String(e), 'error'),
                  })}
                >
                  {installSkills.isPending ? t.settings.skillInstalling : t.settings.skillInstall}
                </Button>}
            >
              {/* Per-provider status pills, laid out to wrap side by side so the block stays compact. */}
              <div className="settings-skill-statuses">
                {(systemSkills.data?.skills ?? []).map((s) => {
                  const tone = !s.present ? 'muted' : s.upToDate ? 'success' : s.installed ? 'warning' : 'default';
                  const label = !s.present ? t.settings.skillProviderAbsent : s.upToDate ? t.settings.skillUpToDate : s.installed ? t.settings.skillOutdated : t.settings.skillMissing;
                  return (
                    <div key={s.provider} className="flex items-center gap-2">
                      <span className="font-mono text-sm text-text">{s.provider}</span>
                      <Badge tone={tone}>{label}</Badge>
                    </div>
                  );
                })}
              </div>
            </SettingsGroup>
            <SettingsGroup title={t.settings.providers} density="compact">
              {PROVIDERS.map((p) => {
                const cur = providers[p.id] ?? { bin: p.binHint, args: '', skipPermissions: true, resume: true };
                const set = (patch: Partial<{ bin: string; args: string; skipPermissions: boolean; resume: boolean }>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                return (
                  <div key={p.id} className="settings-agent-row @container">
                  <div className="flex flex-col gap-3 @sm:flex-row @sm:items-start">
                    <div className="flex items-center gap-3 @sm:w-44 @sm:shrink-0 @sm:pt-1">
                      <ProviderLogo meta={p} alt={t.providers[p.id as keyof typeof t.providers]} size={56} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-text">
                          {t.providers[p.id as keyof typeof t.providers]}
                          {p.embedded ? <HelpTip align="left">{t.help.embeddedProvider}</HelpTip> : null}
                        </div>
                        <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
                      </div>
                    </div>
                    {p.embedded ? null : (
                    <div className="flex flex-1 flex-col gap-3">
                      <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
                        <Field label={t.settings.binary}>
                          <Input value={cur.bin} placeholder={p.binHint} onChange={(e) => set({ bin: e.target.value })} className="font-mono text-xs" />
                        </Field>
                        <Field label={t.settings.extraArgs}>
                          <Input value={cur.args} placeholder={p.argsHint} onChange={(e) => set({ args: e.target.value })} className="font-mono text-xs" />
                        </Field>
                      </div>
                      {p.noBypassFlag ? (
                        <p className="border-t border-border/70 pt-2 text-[11px] leading-relaxed text-text-muted">{t.settings.skipPermissionsNoop}</p>
                      ) : (
                        <label className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
                          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text">
                            {t.settings.skipPermissions}
                            <HelpTip align="left">{t.help.skipPermissions}</HelpTip>
                          </span>
                          <Toggle checked={cur.skipPermissions !== false} onChange={(v) => set({ skipPermissions: v })} label={t.settings.skipPermissions} />
                        </label>
                      )}
                      <label className="flex items-center justify-between gap-3 border-t border-border/70 pt-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text">
                          {t.settings.resumeSessions}
                          <HelpTip align="left">{t.help.resumeSessions}</HelpTip>
                        </span>
                        <Toggle checked={cur.resume !== false} onChange={(v) => set({ resume: v })} label={t.settings.resumeSessions} />
                      </label>
                    </div>
                    )}
                  </div>
                  </div>
                );
              })}
            </SettingsGroup>
          </>
        </SettingsPanel>


        <SettingsPanel id="system" active={category} visited={visitedCategories}>
          <SettingsScope id="system" core={t.settings.system}>
            {(() => {
              // PROTOTYPE(constellation): the same rows feed both layouts — one merged orbit +
              // classic diagnostics widget in cosmos mode, the original two-column grid otherwise.
              // The version/update controls lived in the deck hero before it went compact.
              const sys = SETTINGS_CONSTELLATION.system;
              const updateBadge = system.data?.updateAvailable
                ? <Badge tone="warning">{t.settings.updateAvailable.replace('{v}', system.data?.latest ?? '')}</Badge>
                : <Badge tone="success">{t.settings.upToDate}</Badge>;
              const rowVersion = (
                <SettingsRow
                  label={t.common.appName}
                  description={system.data?.lastUpdatedAt ? t.settings.lastUpdated.replace('{date}', new Date(system.data.lastUpdatedAt).toLocaleString()) : undefined}
                  icon={Sparkles}
                  status={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{system.data?.version ?? '—'}</span>{updateBadge}</span>}
                  actions={system.data?.updateAvailable ? (
                    <button type="button" className="spatial-inline-action text-accent" disabled={systemUpdate.isPending} onClick={() => systemUpdate.mutate(undefined, {
                      onSuccess: () => toast(t.settings.updateStarted),
                      onError: (e) => toast(e instanceof ElowenApiError && e.code === 'mission_running' ? t.settings.updateBlockedMission : String(e), 'error'),
                    })}>{systemUpdate.isPending ? t.settings.updating : t.settings.updateNow}<RefreshCw size={13} className={systemUpdate.isPending ? 'animate-spin' : ''} aria-hidden /></button>
                  ) : (
                    <button type="button" className="spatial-inline-action" onClick={() => { void system.refetch(); }}>{t.settings.checkUpdates}<RefreshCw size={13} aria-hidden /></button>
                  )}
                />
              );
              const serviceRows = [
                { name: t.settings.serviceDaemon, port: ':4400', up: !system.isError, target: 'daemon' as const, restartLabel: t.settings.restartDaemon },
                { name: t.settings.serviceWeb, port: ':4500', up: true, target: 'web' as const, restartLabel: t.settings.restartWeb },
              ].map((service) => (
                <SettingsRow
                  key={service.port}
                  label={service.name}
                  status={<span className="font-mono">{service.port}</span>}
                  icon={Server}
                  actions={<button type="button" className="spatial-inline-action" disabled={systemRestart.isPending} onClick={() => setRestartTarget(service.target)}>{service.restartLabel}<RotateCcw size={13} aria-hidden /></button>}
                >
                  <span className={`settings-control-row__status ${service.up ? '' : 'settings-control-row__status--down'}`}><i aria-hidden />{service.up ? t.settings.serviceUp : t.settings.serviceDown}</span>
                </SettingsRow>
              ));
              const rowAutoUpdate = (
                <SettingsRow label={t.settings.autoUpdate} icon={RefreshCw}>
                  {sys
                    ? <Toggle checked={autoUpdate} onChange={setAutoUpdate} label={t.settings.autoUpdate} />
                    : <span className="settings-control-row__control"><Toggle checked={autoUpdate} onChange={setAutoUpdate} label={t.settings.autoUpdate} /><span>{autoUpdate ? t.settings.on : t.settings.off}</span></span>}
                </SettingsRow>
              );
              const rowTokenTtl = (
                <SettingsRow label={t.settings.tokenTtl} description={t.help.tokenTtl} icon={KeyRound}>
                  <input type="number" min={1} value={defTokenTtl} onChange={(e) => setDefTokenTtl(Number(e.target.value))} className={inputClass} aria-label={t.settings.tokenTtl} />
                </SettingsRow>
              );
              const rowRetention = (
                <SettingsRow label={t.settings.retention.label} description={t.settings.retention.hint} icon={CalendarClock}>
                  <div className="flex items-center gap-3">
                    <Toggle checked={retention.enabled} onChange={(next) => void saveRetention({ enabled: next })} label={t.settings.retention.label} />
                    <label className="flex items-center gap-2 whitespace-nowrap text-xs text-text-muted">
                      {t.settings.retention.olderThan}
                      <Input
                        type="number"
                        min={1}
                        value={retentionDaysDraft}
                        disabled={!retention.enabled}
                        onChange={(e) => setRetentionDaysDraft(e.target.value)}
                        onBlur={commitRetentionDays}
                        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        className="w-16 text-center"
                        aria-label={t.settings.retention.olderThan}
                      />
                      {t.settings.retention.days}
                    </label>
                  </div>
                </SettingsRow>
              );
              const diagnosticsGroup = (
                <SettingsGroup title={t.settings.systemDiagnostics} description={t.settings.systemSectionHint} icon={Gauge} className="settings-diagnostics" variant="classic">
                  <div className="settings-diagnostics__metrics" aria-busy={!diagnostics}>
                  {[
                    { label: t.settings.diagnosticCpu, value: diagnostics ? `${diagnostics.cpuPercent}%` : '—', level: diagnostics?.cpuPercent ?? 0 },
                    { label: t.settings.diagnosticMemory, value: diagnostics ? formatMemory(diagnostics.memoryUsedBytes, diagnostics.memoryTotalBytes) : '—', level: diagnostics?.memoryTotalBytes ? (diagnostics.memoryUsedBytes / diagnostics.memoryTotalBytes) * 100 : 0 },
                    { label: t.settings.diagnosticUptime, value: diagnostics ? formatUptime(diagnostics.uptimeSeconds) : '—', level: diagnostics ? 72 : 0 },
                  ].map((metric) => (
                    <div key={metric.label} className={`settings-diagnostic-metric ${diagnostics ? '' : 'settings-diagnostic-metric--loading'}`}>
                      <span>{metric.label}</span><strong>{metric.value}</strong>
                      <i aria-hidden><b style={{ width: `${diagnostics ? Math.min(100, Math.max(4, metric.level)) : 28}%` }} /></i>
                    </div>
                  ))}
                  </div>
                </SettingsGroup>
              );
              return sys ? (
                <div className="flex flex-col gap-4">
                  <SettingsGroup>
                    {rowVersion}
                    {serviceRows}
                    {rowAutoUpdate}
                    {rowTokenTtl}
                    {rowRetention}
                  </SettingsGroup>
                  {diagnosticsGroup}
                </div>
              ) : (
                <div className="settings-system-content">
                  <SettingsGroup title={t.settings.servicesAndUpdates} icon={Server} density="compact" className="settings-system-services">
                    {rowVersion}
                    {serviceRows}
                    {rowAutoUpdate}
                  </SettingsGroup>
                  <SettingsGroup title={t.settings.sessionsAndSecurity} icon={KeyRound} className="settings-system-security">
                    {rowTokenTtl}
                    {rowRetention}
                  </SettingsGroup>
                  {diagnosticsGroup}
                </div>
              );
            })()}
          </SettingsScope>
        </SettingsPanel>

        <SettingsPanel id="brain" active={category} visited={visitedCategories}>
          <SettingsScope id="brain" core={t.settings.brain}>
            {/* Cross-link to the model catalog (enable / context-window per model) — the Models section. */}
            <SettingsToolbar>
              <button type="button" onClick={() => setCategory('models')} className="font-medium text-accent hover:underline">
                {t.settings.brainModelsLink}
              </button>
            </SettingsToolbar>
            <BrainSection onSaveState={reportSaveState} />
          </SettingsScope>
        </SettingsPanel>

        <SettingsPanel id="memory" active={category} visited={visitedCategories}>
          <SettingsScope id="memory" core={t.settings.memory}><MemorySection onSaveState={reportSaveState} /></SettingsScope>
        </SettingsPanel>

        <SettingsPanel id="plugins" active={category} visited={visitedCategories}><PluginsSection /></SettingsPanel>

        <SettingsPanel id="data" active={category} visited={visitedCategories}>
          <SettingsGroup
            title={t.settings.dangerZone}
            description={t.settings.cleanupDesc}
            icon={Trash2}
            tone="danger"
            actions={<Button variant="danger" icon={Trash2} disabled={cleanup.isPending} onClick={() => setCleanupOpen(true)}>
                {t.settings.cleanupButton}
              </Button>}
          >
            <SettingsState tone="danger">{t.settings.cleanupConfirmDesc}</SettingsState>
          </SettingsGroup>
        </SettingsPanel>

      </SpatialControlDeck>
      </div>

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

      <ConfirmDialog
        open={cleanupOpen}
        title={t.settings.cleanupConfirmTitle}
        description={t.settings.cleanupConfirmDesc}
        confirmLabel={t.settings.cleanupButton}
        onConfirm={() => {
          setCleanupOpen(false);
          cleanup.mutate(undefined, {
            onSuccess: (r) => toast(t.settings.cleanupDone.replace('{tasks}', String(r.tasks)).replace('{missions}', String(r.missions))),
            onError: (e) => toast(String(e), 'error'),
          });
        }}
        onClose={() => setCleanupOpen(false)}
      />
    </ModuleShell>
  );
}
