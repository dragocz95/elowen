'use client';
export const dynamic = 'force-dynamic';
import { useEffect, useState, useRef, useMemo } from 'react';
import { Boxes, Bot, SlidersHorizontal, Plus, X, Pencil, Plug, Radio, Cpu, Gauge, Layers, Link2, KeyRound, FileText, Eye, Lock, Trash2, GitPullRequest, GitBranch, TerminalSquare, Github, RefreshCw, RotateCcw, Server, Sparkles, Puzzle, BrainCircuit, Database, type LucideIcon } from 'lucide-react';
import { PROVIDERS, ProviderLogo } from '../../modules/settings/providers';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { ProviderPicker } from '../../components/ui/ProviderPicker';
import { ModelPillsPicker } from '../../components/ui/ModelPillsPicker';
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
import { OrcaApiError } from '../../lib/orcaClient';
import { allModels, isPresetExec, removeModel, upsertModel } from '../../lib/execPresets';
import { usePersistentState } from '../../lib/usePersistentState';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingCard } from '../../components/ui/SettingCard';
import { SettingsLayout } from '../../components/ui/SettingsLayout';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';
import { useTranslation } from '../../lib/i18n';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

/** Per-role reasoning backend picker: "Relay (model via API)" by default, or a CLI agent model from
 *  the configured list. Mirrors the executor Select used elsewhere, with a live model badge. An
 *  empty value means relay (the role falls back to the planner/overseer relay model). */
function BackendPicker({ value, onChange, models, relayLabel, allowRelay = true }: { value: string; onChange: (v: string) => void; models: { label: string; exec: string }[]; relayLabel: string; allowRelay?: boolean }) {
  const { t } = useTranslation();
  const known = new Set(models.map((m) => m.exec));
  // Surface a saved-but-unknown model (e.g. a removed preset) as its own pill so it stays selectable.
  const list = value && !known.has(value) ? [{ label: value, exec: value }, ...models] : models;
  return (
    <ExecutorPicker value={value} onChange={onChange} models={list} allowDefault={allowRelay} defaultLabel={relayLabel} moreLabel={t.tasks.moreModels} />
  );
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

const CATEGORY_VALUES = ['models', 'providers', 'defaults', 'brain', 'memory', 'plugins', 'autopilot', 'github', 'system', 'data'] as const;
type Category = (typeof CATEGORY_VALUES)[number];

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

  // Remember the last settings section across reloads (F5) until the user switches.
  const [category, setCategory] = usePersistentState<Category>('orca.settings.category', 'models', CATEGORY_VALUES);

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [modelNotes, setModelNotes] = useState<Record<string, string>>({});
  // Per-model max context window overrides (Orca AI models only), keyed `providerId/model`. Lives here
  // in the Models section next to where models are enabled — one home for all Orca AI model config.
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({});
  // The model whose autopilot description is being edited (null = editor closed).
  const [noteFor, setNoteFor] = useState<{ label: string; exec: string } | null>(null);
  // The Orca AI model whose context-window override is being edited (null = editor closed).
  const [ctxFor, setCtxFor] = useState<{ model: string; key: string; effective: number } | null>(null);
  const [model, setModel] = useState('');
  const [overseerModel, setOverseerModel] = useState('');
  const [pilotExec, setPilotExec] = useState('');
  const [overseerExec, setOverseerExec] = useState('');
  // Autopilot backend is an either/or: 'relay' (planner+overseer via API) or 'agents' (CLI agents
  // that read the repo). Derived from whether an exec is set; the picker enforces the exclusivity.
  const [reasoningMode, setReasoningMode] = useState<'relay' | 'agents'>('relay');
  const [reviewOnDone, setReviewOnDone] = useState(false);
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
        ? { pilotExec, overseerExec, reviewOnDone, notes }
        : { model, overseerModel, apiUrl, providerId: apProviderId, pilotExec: '', overseerExec: '', notes, ...(apiKey ? { apiKey } : {}) } },
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
  useAutoSave([reasoningMode, pilotExec, overseerExec, reviewOnDone, notes, model, overseerModel, apiUrl, apiKey, apProviderId], saveAutopilot, { ready });
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



  const SECTIONS: { id: Category; icon: LucideIcon }[] = [
    { id: 'models', icon: Boxes },
    { id: 'providers', icon: Plug },
    { id: 'defaults', icon: SlidersHorizontal },
    { id: 'brain', icon: BrainCircuit },
    { id: 'memory', icon: Database },
    { id: 'plugins', icon: Puzzle },
    { id: 'autopilot', icon: Bot },
    { id: 'github', icon: Github },
    { id: 'system', icon: Server },
    { id: 'data', icon: Trash2 },
  ];

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
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal} />

      {/* Sidebar layout: sticky category rail on the left, section content beside it. */}
      <SettingsLayout
        ariaLabel={t.settings.sectionsNav}
        sections={SECTIONS.map(({ id, icon }) => ({ id, label: t.settings[id], icon }))}
        value={category}
        onChange={(v) => setCategory(v as Category)}
      >
        {category === 'models' && (
          <>
            {/* The catalog half of the models story: WHICH models exist and are enabled. Where they
             *  come from (accounts, keys, endpoints) is the Orca AI section — cross-linked here. */}
            <p className="-mb-2 text-xs text-text-muted">
              {t.settings.modelsIntro}{' '}
              <button type="button" onClick={() => setCategory('brain')} className="font-medium text-accent hover:underline">
                {t.settings.embeddedProviderLink}
              </button>
            </p>
            {/* One catalog, grouped by the engine that runs the model — the same grouping the
             *  executor picker uses, so what admins configure here matches what users pick. */}
            {PROVIDERS.map((prov) => {
              const cliItems = models.filter((m) => execProvider(m.exec) === prov.id);
              const orcaItems = prov.id === 'orca' ? (brainModels.data ?? []) : [];
              if (cliItems.length === 0 && orcaItems.length === 0) return null;
              const groupExecs = [...cliItems.map((m) => m.exec), ...orcaItems.map((m) => m.exec)];
              const enabledCount = groupExecs.filter((e) => allowed.includes(e)).length;
              return (
                <div key={prov.id} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2.5">
                    <ProviderLogo meta={prov} size={28} />
                    <span className="text-sm font-semibold text-text">{prov.label}</span>
                    <span className="font-mono text-tiny text-text-muted">{enabledCount}/{groupExecs.length}</span>
                    {prov.embedded ? <HelpTip align="left">{t.help.orcaModels}</HelpTip> : null}
                  </div>
                  <div className="@container">
                  <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
                    {cliItems.map((p) => {
                      const isCustom = !isPresetExec(p.exec);
                      return (
                        <div key={p.exec} className="card-interactive group relative flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
                          {/* Always visible on touch (no hover exists on phones, so hover-only buttons are
                           *  unreachable — you could only toggle a model, never edit/delete it). On desktop
                           *  (sm+) keep the clean hover-reveal, plus focus-within for keyboard access. */}
                          <div className="absolute right-3 top-3 z-10 flex gap-1 opacity-100 transition-opacity @sm:opacity-0 @sm:group-hover:opacity-100 @sm:focus-within:opacity-100" style={{ transitionDuration: 'var(--motion-fast)' }}>
                            <button
                              type="button"
                              aria-label={t.settings.editLabel.replace('{exec}', p.exec)}
                              title={t.settings.editLabel.replace('{exec}', p.exec)}
                              onClick={() => startEdit(p)}
                              className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
                              style={{ transitionDuration: 'var(--motion-fast)' }}
                            >
                              <Pencil size={13} aria-hidden />
                            </button>
                            <button
                              type="button"
                              aria-label={t.settings.deleteLabel.replace('{exec}', p.exec)}
                              title={t.settings.deleteLabel.replace('{exec}', p.exec)}
                              onClick={() => setPendingDelete(p.exec)}
                              className="flex h-6 w-6 items-center justify-center rounded-md border border-danger/60 bg-surface text-danger transition-colors hover:bg-danger hover:text-white"
                              style={{ transitionDuration: 'var(--motion-fast)' }}
                            >
                              <X size={13} aria-hidden />
                            </button>
                          </div>
                          <div className="flex items-start gap-3 pr-14">
                            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                              <ModelIcon name={p.exec} size={20} />
                            </span>
                            <div className="flex min-w-0 flex-col gap-1">
                              <span className="truncate text-sm font-medium text-text">{p.label}{!isCustom ? <span className="ml-1.5 text-tiny uppercase tracking-wide text-text-muted/70">{t.settings.presetTag}</span> : null}</span>
                              <span className="truncate font-mono text-xs text-text-muted">{execModel(p.exec)}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => setNoteFor({ label: p.label, exec: p.exec })}
                            title={t.settings.modelNoteEdit}
                            className={`line-clamp-2 min-h-[2.25rem] text-left text-xs ${modelNotes[p.exec]?.trim() ? 'text-text-muted hover:text-text' : 'italic text-text-muted/60 hover:text-text-muted'}`}
                          >
                            {modelNotes[p.exec]?.trim() || t.settings.modelNoteAdd}
                          </button>
                          <div className="mt-auto flex items-center gap-2">
                            <Toggle checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} label={p.label} />
                          </div>
                        </div>
                      );
                    })}
                    {orcaItems.map((m) => {
                      const winKey = `${m.provider}/${m.model}`;
                      // Local state is the live truth for overrides (seeded from the same config
                      // `m.contextWindowSet` derives from, then autosaved), so a just-set or
                      // just-cleared override renders immediately without waiting for a refetch.
                      const override = modelWindows[winKey];
                      const overridden = override != null;
                      return (
                      <div key={m.exec} className="card-interactive flex flex-col gap-3.5 rounded-xl border border-border bg-surface p-5">
                        <div className="flex items-start gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated">
                            <ModelIcon name={m.model} size={20} />
                          </span>
                          <div className="flex min-w-0 flex-col gap-1">
                            <span className="truncate text-sm font-medium text-text">{m.model}</span>
                            <span className="truncate font-mono text-xs text-text-muted">{m.exec}</span>
                          </div>
                        </div>
                        {/* Footer: enable toggle + a compact context-window pill (Gauge icon, edited in a
                         *  focused modal) sitting next to the provider badge. Accent-tinted when an
                         *  override is set, quiet otherwise. Wraps on narrow/phone widths. */}
                        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                          <Toggle checked={allowed.includes(m.exec)} onChange={() => toggle(m.exec)} label={m.model} />
                          <div className="flex min-w-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setCtxFor({ model: m.model, key: winKey, effective: m.contextWindow })}
                              title={`${t.brain.contextWindowEdit} · ${formatTokens(override ?? m.contextWindow)}`}
                              aria-label={`${t.brain.contextWindowEdit}: ${m.model}`}
                              className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs transition-colors ${overridden ? 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
                            >
                              <Gauge size={12} aria-hidden />
                              {formatTokens(override ?? m.contextWindow)}
                            </button>
                            <Badge>{m.providerLabel}</Badge>
                          </div>
                        </div>
                      </div>
                      );
                    })}
                  </div>
                  </div>
                </div>
              );
            })}

            <div>
              <Button variant="ghost" icon={Plus} onClick={() => { setEditingExec(null); setShowAddForm(true); }}>
                {t.settings.addModel}
              </Button>
            </div>
          </>
        )}

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

        {category === 'autopilot' && (
            <div className="flex flex-col gap-4">
              {/* One clear choice: how the planner + overseer reason. Relay (API) OR CLI agents. */}
              <div className="card-interactive rounded-xl border border-border bg-surface p-5">
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text">{t.settings.backendMode}</span>
                  <HelpTip>{t.help.backendMode}</HelpTip>
                </div>
                <Segmented
                  value={reasoningMode}
                  onChange={(v) => switchReasoning(v as 'relay' | 'agents')}
                  options={[
                    { value: 'relay', label: t.settings.modeRelay, icon: Radio },
                    { value: 'agents', label: t.settings.modeAgents, icon: Bot },
                  ]}
                />
                <p className="mt-2 text-xs text-text-muted">{reasoningMode === 'relay' ? t.settings.modeRelayDesc : t.settings.modeAgentsDesc}</p>
              </div>

              <div className="@container">
              <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
              {reasoningMode === 'relay' ? (
                <>
                  <SettingCard title={t.settings.apProvider} description={t.help.apProvider} icon={KeyRound} className="@sm:col-span-2">
                    <ProviderPicker
                      providers={(config.data?.brain?.providers ?? []).filter((p) => p.apiKeySet).map((p) => ({ id: p.id, label: p.label }))}
                      value={apProviderId}
                      onChange={setApProviderId}
                      label={t.settings.apProvider}
                      emptyText={t.settings.apNoProviders}
                    />
                  </SettingCard>
                  <SettingCard title={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                    {apProviderId && apCatalog.length > 0
                      ? <ModelPillsPicker mode="single" catalog={apCatalog} value={model || null} onChange={(m) => setModel(m ?? '')} />
                      : <ModelInput value={model} onChange={setModel} placeholder={t.settings.plannerPlaceholder} />}
                  </SettingCard>
                  <SettingCard title={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                    {apProviderId && apCatalog.length > 0
                      ? <ModelPillsPicker mode="single" catalog={apCatalog} value={overseerModel || null} onChange={(m) => setOverseerModel(m ?? '')} />
                      : <ModelInput value={overseerModel} onChange={setOverseerModel} placeholder={t.settings.overseerPlaceholder} />}
                  </SettingCard>
                  {/* No provider picked → enter an endpoint + key directly. A chosen provider supplies both,
                      so these fields simply don't render (no redundant "inherited" note). */}
                  {apProviderId === '' ? (
                    <>
                      <SettingCard title={t.settings.apiUrl} description={t.help.apiUrl} icon={Link2}>
                        <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} />
                      </SettingCard>
                      <SettingCard title={t.settings.apiKey} description={apiKeySet ? t.help.apiKey : t.help.apiKeyNotSet} icon={KeyRound}>
                        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? t.settings.apiKeySetPlaceholder : t.settings.apiKeyPlaceholder} className={inputClass} />
                      </SettingCard>
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <SettingCard title={t.settings.plannerModel} description={t.help.plannerModel} icon={Bot}>
                    <BackendPicker value={pilotExec} onChange={setPilotExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingCard>
                  <SettingCard title={t.settings.overseerModel} description={t.help.overseerModel} icon={Eye}>
                    <BackendPicker value={overseerExec} onChange={setOverseerExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingCard>
                  <SettingCard title={t.settings.reviewOnDone} description={t.help.reviewOnDone} icon={Eye}>
                    <Toggle checked={reviewOnDone} onChange={setReviewOnDone} label={t.settings.reviewOnDone} />
                  </SettingCard>
                </>
              )}
              <SettingCard title={t.settings.notes} description={t.help.notes} icon={FileText}>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
              </SettingCard>
              </div>
              </div>
            </div>
        )}

        {category === 'github' && (
          <div className="@container">
          <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
            <GithubStatusBanner />
            <SettingCard title={t.settings.ghToken} description={ghTokenSet ? t.help.ghToken : t.help.ghTokenNotSet} icon={KeyRound}>
              <input type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={ghTokenSet ? t.settings.apiKeySetPlaceholder : t.settings.ghTokenPlaceholder} className={inputClass} />
            </SettingCard>
            <SettingCard title={t.settings.prEnabled} description={t.help.prEnabled} icon={GitPullRequest}>
              <Toggle checked={prEnabled} onChange={setPrEnabled} label={t.settings.prEnabled} />
            </SettingCard>
            <SettingCard title={t.settings.prBaseBranch} description={t.help.prBaseBranch} icon={GitBranch}>
              <input value={prBaseBranch} onChange={(e) => setPrBaseBranch(e.target.value)} placeholder={t.settings.prBaseBranchPlaceholder} className={inputClass} />
            </SettingCard>
            <SettingCard title={t.settings.prAutoOpen} description={t.help.prAutoOpen} icon={GitPullRequest}>
              <Toggle checked={prAutoOpen} onChange={setPrAutoOpen} label={t.settings.prAutoOpen} />
            </SettingCard>
            <SettingCard title={t.settings.prVerifyCommand} description={t.help.prVerifyCommand} icon={TerminalSquare}>
              <input value={prVerifyCommand} onChange={(e) => setPrVerifyCommand(e.target.value)} placeholder={t.settings.prVerifyCommandPlaceholder} className={`${inputClass} font-mono text-xs`} />
            </SettingCard>
          </div>
          </div>
        )}

        {category === 'providers' && (
          <div>
            <div className="flex flex-col gap-3">
              {PROVIDERS.map((p) => {
                const cur = providers[p.id] ?? { bin: p.binHint, args: '', skipPermissions: true, resume: true };
                const set = (patch: Partial<{ bin: string; args: string; skipPermissions: boolean; resume: boolean }>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                return (
                  <div key={p.id} className="@container">
                  <div className="card-interactive flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 @sm:flex-row @sm:items-start">
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
        )}

        {category === 'defaults' && (
            <div className="@container">
            <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
              <SettingCard title={t.settings.executor} description={t.help.executor} icon={Cpu}>
                {/* Same grouped picker the task modal uses (workers + Orca AI sections), so the
                    default executor can also be a brain model. A saved value missing from the
                    catalog still shows as its own pill. */}
                <BackendPicker value={defExec} onChange={setDefExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
              </SettingCard>
              <SettingCard title={t.settings.autonomy} description={t.help.autonomy} icon={Gauge}>
                <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
                <p className="mt-2 text-xs leading-relaxed text-text-muted">
                  {({ L0: t.missions.autonomyL0Desc, L1: t.missions.autonomyL1Desc, L2: t.missions.autonomyL2Desc, L3: t.missions.autonomyL3Desc } as Record<string, string>)[defAutonomy]}
                </p>
              </SettingCard>
              <SettingCard title={t.settings.maxSessions} description={t.help.maxSessions} icon={Layers}>
                <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} />
              </SettingCard>
            </div>
            </div>
        )}

        {category === 'system' && (
            <div className="flex flex-col items-center gap-5">
              {/* Hero — Orca identity, current version and the update affordance, on a softly back-lit
                  tile. The blurred accent orb behind the logo is the "lehké podsvícení". */}
              <div className="relative w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-surface px-6 py-9 text-center" style={{ boxShadow: 'var(--shadow-raised)' }}>
                <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-44 w-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/25 blur-3xl" />
                <div className="relative flex flex-col items-center gap-5">
                  <img src="/orca-logo.png" alt={t.common.appName} className="h-12 w-auto" />
                  <div className="flex flex-col items-center gap-2.5">
                    <span className="bg-gradient-to-b from-text to-text-muted bg-clip-text font-mono text-4xl font-bold tracking-tight text-transparent">{system.data?.version ?? '—'}</span>
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
                      onError: (e) => toast(e instanceof OrcaApiError && e.code === 'mission_running' ? t.settings.updateBlockedMission : String(e), 'error'),
                    })}
                    disabled={systemUpdate.isPending || !system.data?.updateAvailable}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-accent bg-accent px-4 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:border-border disabled:bg-elevated disabled:text-text-muted disabled:opacity-60"
                  >
                    <RefreshCw size={14} className={systemUpdate.isPending ? 'animate-spin' : ''} />
                    {systemUpdate.isPending ? t.settings.updating : t.settings.updateNow}
                  </button>
                </div>
              </div>

              {/* Tiles — Orca-specific controls, sized to breathe and read at a glance. */}
              <div className="@container w-full max-w-lg">
              <div className="grid w-full grid-cols-1 gap-4 @sm:grid-cols-2">
                {/* Auto-update — a full-size pill switch, no fine print. */}
                <div className="card-interactive flex min-h-[150px] flex-col gap-4 rounded-xl border border-border bg-surface p-6">
                  <div className="flex items-center gap-2.5">
                    <RefreshCw size={16} className="text-text-muted" aria-hidden />
                    <span className="text-sm font-medium text-text">{t.settings.autoUpdate}</span>
                  </div>
                  <div className="flex flex-1 items-center gap-3">
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
                </div>
                {/* Services — live health with a pulsing dot. */}
                <div className="card-interactive flex min-h-[150px] flex-col gap-4 rounded-xl border border-border bg-surface p-6">
                  <div className="flex items-center gap-2.5">
                    <Server size={16} className="text-text-muted" aria-hidden />
                    <span className="text-sm font-medium text-text">{t.settings.services}</span>
                  </div>
                  <div className="flex flex-1 flex-col justify-center gap-3.5">
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
                </div>
              </div>
              </div>

              {/* Agent skills — install/verify the `orca-workflow` skill across the agent providers.
                  The daemon self-installs on startup; this is the on-demand re-apply + per-provider status. */}
              <div className="card-interactive flex w-full max-w-lg flex-col gap-4 rounded-xl border border-border bg-surface p-6">
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
                <div className="flex flex-col gap-3">
                  {(systemSkills.data?.skills ?? []).map((s) => {
                    const tone = !s.present ? 'muted' : s.upToDate ? 'success' : s.installed ? 'warning' : 'default';
                    const label = !s.present ? t.settings.skillProviderAbsent : s.upToDate ? t.settings.skillUpToDate : s.installed ? t.settings.skillOutdated : t.settings.skillMissing;
                    return (
                      <div key={s.provider} className="flex items-center justify-between">
                        <span className="font-mono text-sm text-text">{s.provider}</span>
                        <Badge tone={tone}>{label}</Badge>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Session token TTL — a server-wide security setting, so it lives with the other
                  server controls rather than among the per-task defaults. Same autosave as defaults. */}
              <div className="w-full max-w-lg">
                <SettingCard title={t.settings.tokenTtl} description={t.help.tokenTtl} icon={KeyRound}>
                  <input type="number" min={1} value={defTokenTtl} onChange={(e) => setDefTokenTtl(Number(e.target.value))} className={inputClass} />
                </SettingCard>
              </div>
            </div>
        )}

        {category === 'brain' && (
          <>
            {/* The connections half of the models story: accounts, providers and keys (+ agent
             *  identity). The catalog itself — enable/context-window per model — is Models. */}
            <p className="-mb-2 text-xs text-text-muted">
              {t.settings.brainIntro}{' '}
              <button type="button" onClick={() => setCategory('models')} className="font-medium text-accent hover:underline">
                {t.settings.brainModelsLink}
              </button>
            </p>
            <BrainSection />
          </>
        )}

        {category === 'memory' && <MemorySection />}

        {category === 'plugins' && <PluginsSection />}

        {category === 'data' && (
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
        )}

      </SettingsLayout>

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
