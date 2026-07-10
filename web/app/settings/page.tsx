'use client';
export const dynamic = 'force-dynamic';
import { Activity, useEffect, useState, useRef, useMemo, type ReactNode } from 'react';
import { Bot, SlidersHorizontal, Plus, X, Pencil, Radio, Cpu, Gauge, Layers, Link2, KeyRound, FileText, Eye, Lock, Trash2, GitPullRequest, GitBranch, TerminalSquare, RefreshCw, RotateCcw, Sparkles, FlaskConical, Search } from 'lucide-react';
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
import { execProvider, execModel, type ProviderId } from '../../lib/modelProvider';
import { formatTokens } from '../../lib/format';
import { useBrainModels, useConfig, useMe, useSystem, useSystemSkills } from '../../lib/queries';
import { useAutoSave } from '../../lib/useAutoSave';
import { useUpdateConfig, useCleanupAll, useSystemUpdate, useSystemRestart, useInstallSkills } from '../../lib/mutations';
import { ElowenApiError } from '../../lib/elowenClient';
import { allModels, isPresetExec, removeModel, upsertModel } from '../../lib/execPresets';
import { usePersistentState } from '../../lib/usePersistentState';
import { useSearchParams } from 'next/navigation';
import { SETTINGS_CATEGORY_VALUES, SETTINGS_SECTIONS, type SettingsCategory } from '../../modules/settings/categories';
import { PageLayout } from '../../components/ui/PageLayout';
import { RailCard } from '../../components/ui/RailCard';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingsLayout } from '../../components/ui/SettingsLayout';
import { SettingGroup, SettingRow } from '../../components/ui/SettingsPrimitives';
import { MotionReveal } from '../../components/ui/Motion';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';
import { useTranslation } from '../../lib/i18n';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

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
      <MotionReveal data-settings-panel={id}>{children}</MotionReveal>
    </Activity>
  );
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
  const [category, setCategoryState] = usePersistentState<Category>('elowen.settings.category', 'models', CATEGORY_VALUES);
  const [visitedCategories, setVisitedCategories] = useState<Set<Category>>(() => new Set([category]));
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

  // Persist only the active mode's fields, and explicitly clear the other backend so the two never
  // coexist (relay clears the execs; agents leave the relay model/key untouched but unused).
  const saveAutopilot = () => {
    update.mutate(
      { autopilot: reasoningMode === 'agents'
        ? { pilotExec, overseerExec, reviewOnDone, tddMode, notes }
        : { model, overseerModel, apiUrl, providerId: apProviderId, pilotExec: '', overseerExec: '', tddMode, notes, ...(apiKey ? { apiKey } : {}) } },
      { onSuccess: () => { if (apiKey) setApiKey(''); }, onError: (e) => toast(String(e), 'error') },
    );
  };

  // GitHub / PR-native settings live in their own section. The global prEnabled is the DEFAULT for new
  // projects; each project can override it. The ghToken is write-only — sent only when freshly typed.
  const saveGithub = () => {
    update.mutate(
      { autopilot: { prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ...(ghToken ? { ghToken } : {}) } },
      { onSuccess: () => { if (ghToken) setGhToken(''); }, onError: (e) => toast(String(e), 'error') },
    );
  };

  const saveProviders = () =>
    update.mutate({ providers }, { onError: (e) => toast(String(e), 'error') });

  // autoUpdate is NOT bundled here — the System toggle is its single writer (it persists inline).
  const saveDefaults = () =>
    update.mutate(
      { defaults: { exec: defExec, autonomy: defAutonomy, maxSessions: defMaxSessions }, security: { tokenTtlDays: defTokenTtl } },
      { onError: (e) => toast(String(e), 'error') },
    );

  // Auto-persist: every settings form saves itself shortly after a change (no Save buttons anywhere).
  // Secrets (apiKey/ghToken) ride along only when freshly typed, exactly as with the old buttons.
  const ready = seeded.current;
  useAutoSave([reasoningMode, pilotExec, overseerExec, reviewOnDone, tddMode, notes, model, overseerModel, apiUrl, apiKey, apProviderId], saveAutopilot, { ready });
  useAutoSave([prEnabled, prBaseBranch, prAutoOpen, prVerifyCommand, ghToken], saveGithub, { ready });
  useAutoSave([providers], saveProviders, { ready });
  useAutoSave([defExec, defAutonomy, defMaxSessions, defTokenTtl], saveDefaults, { ready });
  // Per-model context windows auto-persist like every other model setting (no Save button).
  useAutoSave([modelWindows], () => update.mutate({ brain: { modelContextWindows: modelWindows } }, { onError: (e) => toast(String(e), 'error') }), { ready });
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
    update.mutate(
      { allowedExecs, customModels: cm, hiddenPresets: hp, modelNotes: mn },
      { onError: (e) => toast(String(e), 'error') }, // auto-persist is silent on success
    );
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

  return (
    <ModuleShell moduleId="settings">
      <ModuleHeader title={`${t.page.settings} / ${t.settings[category]}`} icon={SlidersHorizontal} />

      <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6">
      <SettingsLayout
        ariaLabel={t.settings.sectionsNav}
        sections={SETTINGS_SECTIONS.map(({ id, icon }) => ({ id, icon, label: t.settings[id] }))}
        value={category}
        onChange={(value) => setCategory(value as Category)}
        searchPlaceholder={t.managePicker.searchPlaceholder}
      >
        <SettingsPanel id="models" active={category} visited={visitedCategories}>
          <>
            <div className="flex flex-col gap-2.5 pb-2">
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
              {/* Quiet cross-link with its own line; it must never collide with the first provider heading. */}
              <button
                type="button"
                onClick={() => setCategory('brain')}
                className="inline-flex w-fit items-center gap-1.5 px-1 text-xs text-text-muted transition-colors hover:text-accent"
              >
                <Link2 size={12} aria-hidden />
                {t.settings.embeddedProviderLink}
              </button>
            </div>
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
                <div key={prov.id} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2.5">
                    <ProviderLogo meta={prov} size={28} />
                    <span className="text-sm font-semibold text-text">{prov.label}</span>
                    <span className="font-mono text-tiny text-text-muted">{enabledCount}/{groupExecs.length}</span>
                    {prov.embedded ? <HelpTip align="left">{t.help.elowenModels}</HelpTip> : null}
                  </div>
                  <div className="@container divide-y divide-border/70 border-y border-border/80">
                    {cliItems.map((p) => {
                      const isCustom = !isPresetExec(p.exec);
                      return (
                        <div data-testid="model-row" key={p.exec} className="group flex min-w-0 items-center gap-3 px-1 py-3.5 transition-colors hover:bg-elevated/30">
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
                      <div data-testid="model-row" key={m.exec} className="flex min-w-0 items-center gap-3 px-1 py-3.5 transition-colors hover:bg-elevated/30">
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
                </div>
              );
            })}

            {modelQuery.trim() && ![
              ...models.map((m) => `${PROVIDERS.find((provider) => provider.id === execProvider(m.exec))?.label ?? ''} ${m.label} ${m.exec} ${execModel(m.exec)} ${modelNotes[m.exec] ?? ''}`),
              ...(brainModels.data ?? []).map((m) => `${PROVIDERS.find((provider) => provider.id === 'elowen')?.label ?? ''} ${m.model} ${m.exec} ${m.providerLabel}`),
            ].some((value) => value.toLocaleLowerCase().includes(modelQuery.trim().toLocaleLowerCase())) ? (
              <p className="border-y border-border/80 py-8 text-center text-sm text-text-muted">{t.settings.modelNoMatches}</p>
            ) : null}

            <div>
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
            <div className="flex flex-col gap-4">
              {/* One clear choice: how the planner + overseer reason. Relay (API) OR CLI agents. */}
              <SettingGroup>
                <SettingRow title={t.settings.backendMode} description={t.help.backendMode} icon={Radio}>
                  <div className="flex flex-col gap-2">
                    <Segmented
                      value={reasoningMode}
                      onChange={(v) => switchReasoning(v as 'relay' | 'agents')}
                      options={[
                        { value: 'relay', label: t.settings.modeRelay, icon: Radio },
                        { value: 'agents', label: t.settings.modeAgents, icon: Bot },
                      ]}
                    />
                    <p className="text-xs text-text-muted">{reasoningMode === 'relay' ? t.settings.modeRelayDesc : t.settings.modeAgentsDesc}</p>
                  </div>
                </SettingRow>
              </SettingGroup>

              <SettingGroup>
              {reasoningMode === 'relay' ? (
                <>
                  <SettingRow title={t.settings.apProvider} description={t.help.apProvider} icon={KeyRound}>
                    <ProviderPicker
                      providers={(config.data?.brain?.providers ?? []).filter((p) => p.apiKeySet).map((p) => ({ id: p.id, label: p.label }))}
                      value={apProviderId}
                      onChange={setApProviderId}
                      label={t.settings.apProvider}
                      emptyText={t.settings.apNoProviders}
                    />
                  </SettingRow>
                  <SettingRow title={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                    {apProviderId && apCatalog.length > 0
                      ? <ModelCatalogField value={model} onChange={setModel} catalog={apCatalog} title={t.settings.plannerModel} subtitle={t.help.plannerModel} />
                      : <ModelInput value={model} onChange={setModel} placeholder={t.settings.plannerPlaceholder} />}
                  </SettingRow>
                  <SettingRow title={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                    {apProviderId && apCatalog.length > 0
                      ? <ModelCatalogField value={overseerModel} onChange={setOverseerModel} catalog={apCatalog} title={t.settings.overseerModel} subtitle={t.help.overseerModel} />
                      : <ModelInput value={overseerModel} onChange={setOverseerModel} placeholder={t.settings.overseerPlaceholder} />}
                  </SettingRow>
                  {/* No provider picked → enter an endpoint + key directly. A chosen provider supplies both,
                      so these fields simply don't render (no redundant "inherited" note). */}
                  {apProviderId === '' ? (
                    <>
                      <SettingRow title={t.settings.apiUrl} description={t.help.apiUrl} icon={Link2}>
                        <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} />
                      </SettingRow>
                      <SettingRow title={t.settings.apiKey} description={apiKeySet ? t.help.apiKey : t.help.apiKeyNotSet} icon={KeyRound}>
                        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? t.settings.apiKeySetPlaceholder : t.settings.apiKeyPlaceholder} className={inputClass} />
                      </SettingRow>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <SettingRow title={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                    <BackendPicker value={pilotExec} onChange={setPilotExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingRow>
                  <SettingRow title={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                    <BackendPicker value={overseerExec} onChange={setOverseerExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingRow>
                  <SettingRow title={t.settings.reviewOnDone} description={t.help.reviewOnDone} icon={Eye}>
                    <Toggle checked={reviewOnDone} onChange={setReviewOnDone} label={t.settings.reviewOnDone} />
                  </SettingRow>
                </>
              )}
              <SettingRow title={t.settings.notes} description={t.help.notes} icon={FileText}>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
              </SettingRow>
              </SettingGroup>

              {/* Default mission run — what the pilot actually launches: the worker executor, the
                  autonomy level and how many agents run in parallel. These apply in both reasoning
                  modes, so they live below the relay/agents split. */}
              <SettingGroup title={t.settings.runDefaults} icon={Cpu}>
                <SettingRow title={t.settings.executor} description={t.help.executor} icon={Cpu}>
                  {/* Same worker + Elowen AI split the task picker uses, in the unified manage-selection
                      modal, so the default executor can also be a brain model. A saved value missing
                      from the catalog stays selectable as a pinned row. */}
                  <BackendPicker value={defExec} onChange={setDefExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                </SettingRow>
                <SettingRow title={t.settings.autonomy} description={t.help.autonomy} icon={Gauge}>
                  <div>
                  <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
                  <p className="mt-2 text-xs leading-relaxed text-text-muted">
                    {({ L0: t.missions.autonomyL0Desc, L1: t.missions.autonomyL1Desc, L2: t.missions.autonomyL2Desc, L3: t.missions.autonomyL3Desc } as Record<string, string>)[defAutonomy]}
                  </p>
                  </div>
                </SettingRow>
                <SettingRow title={t.settings.maxSessions} description={t.help.maxSessions} icon={Layers}>
                  <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} />
                </SettingRow>
                {/* TDD mission mode applies to every worker (standalone, mission phase, embedded) regardless
                    of the relay/agents split, so it lives here with the run defaults — persisted via the
                    autopilot patch (saveAutopilot). */}
                <SettingRow title={t.settings.tddMode} description={t.help.tddMode} icon={FlaskConical}>
                  <Toggle checked={tddMode} onChange={setTddMode} label={t.settings.tddMode} />
                </SettingRow>
              </SettingGroup>
            </div>
        </SettingsPanel>

        <SettingsPanel id="github" active={category} visited={visitedCategories}>
          <div className="flex flex-col gap-4">
            <GithubStatusBanner />
            <SettingGroup>
            <SettingRow title={t.settings.ghToken} description={ghTokenSet ? t.help.ghToken : t.help.ghTokenNotSet} icon={KeyRound}>
              <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? t.settings.apiKeySetPlaceholder : t.settings.ghTokenPlaceholder} className={inputClass} />
            </SettingRow>
            <SettingRow title={t.settings.prEnabled} description={t.help.prEnabled} icon={GitPullRequest}>
              <Toggle checked={prEnabled} onChange={setPrEnabled} label={t.settings.prEnabled} />
            </SettingRow>
            <SettingRow title={t.settings.prBaseBranch} description={t.help.prBaseBranch} icon={GitBranch}>
              <input value={prBaseBranch} onChange={(e) => setPrBaseBranch(e.target.value)} placeholder={t.settings.prBaseBranchPlaceholder} className={inputClass} />
            </SettingRow>
            <SettingRow title={t.settings.prAutoOpen} description={t.help.prAutoOpen} icon={GitPullRequest}>
              <Toggle checked={prAutoOpen} onChange={setPrAutoOpen} label={t.settings.prAutoOpen} />
            </SettingRow>
            <SettingRow title={t.settings.prVerifyCommand} description={t.help.prVerifyCommand} icon={TerminalSquare}>
              <input value={prVerifyCommand} onChange={(e) => setPrVerifyCommand(e.target.value)} placeholder={t.settings.prVerifyCommandPlaceholder} className={`${inputClass} font-mono text-xs`} />
            </SettingRow>
            </SettingGroup>
          </div>
        </SettingsPanel>

        <SettingsPanel id="providers" active={category} visited={visitedCategories}>
          <div className="flex flex-col gap-5">
            {/* Agent skills sit at the top of CLI Agents — they install/verify the `elowen-workflow`
                skill into the very CLI agents this section configures. The daemon self-installs on
                startup; this is the on-demand re-apply + per-provider status. */}
            <section className="flex w-full flex-col gap-4 border-y border-border/80 py-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <Sparkles size={16} className="text-text-muted" aria-hidden />
                  <span className="text-sm font-medium text-text">{t.settings.agentSkills}</span>
                  <HelpTip align="left">{t.help.agentSkills}</HelpTip>
                </div>
                <Button
                  variant="accent"
                  className="h-8 shrink-0"
                  disabled={installSkills.isPending || !(systemSkills.data?.skills ?? []).some((s) => s.present && !s.upToDate)}
                  onClick={() => installSkills.mutate(undefined, {
                    onSuccess: () => toast(t.settings.skillsInstalled),
                    onError: (e) => toast(String(e), 'error'),
                  })}
                >
                  {installSkills.isPending ? t.settings.skillInstalling : t.settings.skillInstall}
                </Button>
              </div>
              {/* Per-provider status pills, laid out to wrap side by side so the block stays compact. */}
              <div className="flex flex-wrap gap-x-6 gap-y-2.5">
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
            </section>
            <div className="flex flex-col gap-3">
              {PROVIDERS.map((p) => {
                const cur = providers[p.id] ?? { bin: p.binHint, args: '', skipPermissions: true, resume: true };
                const set = (patch: Partial<{ bin: string; args: string; skipPermissions: boolean; resume: boolean }>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                return (
                  <div key={p.id} className="@container">
                  <div className="flex flex-col gap-3 border-y border-border/80 py-5 @sm:flex-row @sm:items-start">
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
                    {p.embedded ? (
                      <div className="flex flex-1 flex-col justify-center gap-2 @sm:pt-1">
                        <button type="button" onClick={() => setCategory('brain')} className="self-start text-xs font-medium text-accent hover:underline">
                          {t.settings.embeddedProviderLink}
                        </button>
                      </div>
                    ) : (
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
                        <div className="rounded-md border border-border bg-bg px-3 py-2 text-[11px] text-text-muted">{t.settings.skipPermissionsNoop}</div>
                      ) : (
                        <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2">
                          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text">
                            {t.settings.skipPermissions}
                            <HelpTip align="left">{t.help.skipPermissions}</HelpTip>
                          </span>
                          <Toggle checked={cur.skipPermissions !== false} onChange={(v) => set({ skipPermissions: v })} label={t.settings.skipPermissions} />
                        </label>
                      )}
                      <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg px-3 py-2">
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
            </div>
          </div>
        </SettingsPanel>


        <SettingsPanel id="system" active={category} visited={visitedCategories}>
            <PageLayout
              rail={
                <RailCard title={t.settings.services}>
                  <div className="flex flex-col gap-3.5">
                    {[
                      { name: t.settings.serviceDaemon, port: ':4400', up: !system.isError, target: 'daemon' as const, restartLabel: t.settings.restartDaemon },
                      { name: t.settings.serviceWeb, port: ':4500', up: true, target: 'web' as const, restartLabel: t.settings.restartWeb },
                    ].map((s) => (
                      <div key={s.port} className="flex items-center justify-between">
                        <span className="flex items-center gap-2.5 text-sm text-text">
                          <span className={s.up ? 'live-dot inline-block h-2.5 w-2.5 rounded-full bg-success' : 'inline-block h-2.5 w-2.5 rounded-full bg-danger'} />
                          {s.name} <span className="font-mono text-xs text-text-muted">{s.port}</span>
                        </span>
                        <span className="flex items-center gap-2.5">
                          <span className={`text-xs font-medium ${s.up ? 'text-success' : 'text-danger'}`}>{s.up ? t.settings.serviceUp : t.settings.serviceDown}</span>
                          <button
                            type="button"
                            aria-label={s.restartLabel}
                            title={s.restartLabel}
                            disabled={systemRestart.isPending}
                            onClick={() => setRestartTarget(s.target)}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-elevated text-text-muted transition-colors hover:border-accent hover:text-text disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <RotateCcw size={13} aria-hidden />
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </RailCard>
              }
            >
              <div className="flex flex-col gap-5">
              {/* Hero — Elowen identity, current version and the update affordance. Flat OLED: hairline
                  border, no glow/gradient/shadow. */}
              <div className="relative w-full rounded-2xl border border-border bg-surface px-6 py-9 text-center">
                <div className="relative flex flex-col items-center gap-5">
                  <img src="/elowen-logo.png" alt={t.common.appName} className="h-12 w-auto" />
                  <div className="flex flex-col items-center gap-2.5">
                    <span className="font-mono text-4xl font-bold tracking-tight text-text">{system.data?.version ?? '—'}</span>
                    {system.data?.updateAvailable
                      ? <Badge tone="warning">{t.settings.updateAvailable.replace('{v}', system.data.latest ?? '')}</Badge>
                      : system.data?.latest ? <Badge tone="success">{t.settings.upToDate}</Badge> : null}
                  </div>
                  {system.data?.lastUpdatedAt && (() => {
                    const lastUpdated = new Date(system.data.lastUpdatedAt).toLocaleString();
                    return (
                      <span className="text-xs text-text-muted" title={lastUpdated}>
                        {t.settings.lastUpdated.replace('{date}', lastUpdated)}
                      </span>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => systemUpdate.mutate(undefined, {
                      onSuccess: () => toast(t.settings.updateStarted),
                      onError: (e) => toast(e instanceof ElowenApiError && e.code === 'mission_running' ? t.settings.updateBlockedMission : String(e), 'error'),
                    })}
                    disabled={systemUpdate.isPending || !system.data?.updateAvailable}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-4 text-xs font-medium text-bg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border-border disabled:bg-elevated disabled:text-text-muted disabled:opacity-60"
                  >
                    <RefreshCw size={14} className={systemUpdate.isPending ? 'animate-spin' : ''} />
                    {systemUpdate.isPending ? t.settings.updating : t.settings.updateNow}
                  </button>
                </div>
              </div>

              <SettingGroup>
                {/* Auto-update — a full-size pill switch, no fine print. */}
                <SettingRow title={t.settings.autoUpdate} icon={RefreshCw}>
                  <div className="flex items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoUpdate}
                    aria-label={t.settings.autoUpdate}
                    onClick={() => { const v = !autoUpdate; setAutoUpdate(v); update.mutate({ autoUpdate: v }, { onError: (e) => toast(String(e), 'error') }); }}
                    className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${autoUpdate ? 'border-accent bg-accent' : 'border-border bg-elevated'}`}
                    style={{ transitionDuration: 'var(--motion-fast)' }}
                  >
                    <span
                      className={`absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full shadow-sm ${autoUpdate ? 'bg-bg translate-x-[22px]' : 'bg-text-muted translate-x-[3px]'}`}
                      style={{ transition: 'transform var(--motion-base) var(--ease-spring)' }}
                    />
                  </button>
                  <span className={`text-sm font-medium ${autoUpdate ? 'text-text' : 'text-text-muted'}`}>{autoUpdate ? t.settings.on : t.settings.off}</span>
                  </div>
                </SettingRow>

                {/* Session token TTL — a server-wide security setting, so it lives with the other
                    server controls rather than among the per-task defaults. Same autosave as defaults. */}
                <SettingRow title={t.settings.tokenTtl} description={t.help.tokenTtl} icon={KeyRound}>
                  <input type="number" min={1} value={defTokenTtl} onChange={(e) => setDefTokenTtl(Number(e.target.value))} className={inputClass} />
                </SettingRow>
              </SettingGroup>
              </div>
            </PageLayout>
        </SettingsPanel>

        <SettingsPanel id="brain" active={category} visited={visitedCategories}>
          <>
            {/* Cross-link to the model catalog (enable / context-window per model) — the Models section. */}
            <p className="-mb-2 text-xs">
              <button type="button" onClick={() => setCategory('models')} className="font-medium text-accent hover:underline">
                {t.settings.brainModelsLink}
              </button>
            </p>
            <BrainSection />
          </>
        </SettingsPanel>

        <SettingsPanel id="memory" active={category} visited={visitedCategories}><MemorySection /></SettingsPanel>

        <SettingsPanel id="plugins" active={category} visited={visitedCategories}><PluginsSection /></SettingsPanel>

        <SettingsPanel id="data" active={category} visited={visitedCategories}>
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-danger/40 bg-danger/[0.04] p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-danger">
                <Trash2 size={15} aria-hidden /> {t.settings.dangerZone}
              </div>
              <p className="mt-2 max-w-prose text-sm text-text-muted">{t.settings.cleanupDesc}</p>
              <Button variant="danger" icon={Trash2} className="mt-4 self-start" disabled={cleanup.isPending} onClick={() => setCleanupOpen(true)}>
                {t.settings.cleanupButton}
              </Button>
            </div>
          </div>
        </SettingsPanel>

      </SettingsLayout>
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
