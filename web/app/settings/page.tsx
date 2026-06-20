'use client';
import { useEffect, useState, useRef } from 'react';
import { Save, Boxes, Bot, SlidersHorizontal, Plus, X, Pencil, Plug, Radio, Cpu, Gauge, Layers, Link2, KeyRound, FileText, Eye, Lock, type LucideIcon } from 'lucide-react';
import { PROVIDERS, ProviderLogo, ProviderTag } from '../../modules/settings/providers';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { Select } from '../../components/ui/Select';
import { ModelModal } from '../../modules/settings/ModelModal';
import { execProvider, execModel, type ProviderId } from '../../lib/modelProvider';
import { useConfig, useHermesStatus, useMe } from '../../lib/queries';
import { useUpdateConfig, useHermesInstall } from '../../lib/mutations';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';
import { getToken } from '../../lib/token';
import { EXEC_PRESETS, allModels } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Badge } from '../../components/ui/Badge';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingCard } from '../../components/ui/SettingCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';
import { useTranslation } from '../../lib/i18n';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

const PRESET_EXECS = new Set(EXEC_PRESETS.map((p) => p.exec));

/** Per-role reasoning backend picker: "Relay (model via API)" by default, or a CLI agent model from
 *  the configured list. Mirrors the executor Select used elsewhere, with a live model badge. An
 *  empty value means relay (the role falls back to the planner/overseer relay model). */
function BackendPicker({ value, onChange, models, relayLabel, allowRelay = true }: { value: string; onChange: (v: string) => void; models: { label: string; exec: string }[]; relayLabel: string; allowRelay?: boolean }) {
  const known = new Set(models.map((m) => m.exec));
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg" aria-hidden>
        {value ? <ModelIcon name={value} size={16} /> : <Radio size={14} className="text-text-muted" />}
      </span>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {allowRelay ? <option value="">{relayLabel}</option> : null}
        {value && !known.has(value) ? <option value={value}>{value}</option> : null}
        {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
      </Select>
    </div>
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

type Category = 'models' | 'autopilot' | 'providers' | 'defaults' | 'hermes';

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const me = useMe();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [category, setCategory] = useState<Category>('models');

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [model, setModel] = useState('');
  const [overseerModel, setOverseerModel] = useState('');
  const [pilotExec, setPilotExec] = useState('');
  const [overseerExec, setOverseerExec] = useState('');
  // Autopilot backend is an either/or: 'relay' (planner+overseer via API) or 'agents' (CLI agents
  // that read the repo). Derived from whether an exec is set; the picker enforces the exclusivity.
  const [reasoningMode, setReasoningMode] = useState<'relay' | 'agents'>('relay');
  const [reviewOnDone, setReviewOnDone] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [notes, setNotes] = useState('');
  const [prompt, setPrompt] = useState('');
  const [providers, setProviders] = useState<Record<string, { bin: string; args: string }>>({});
  const [sampleGoal, setSampleGoal] = useState('');
  const [preview, setPreview] = useState<{ title: string; type: string; agent?: string; details?: string }[] | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      // Planning is async: submit a dryRun job, then poll it until it resolves (the relay backend
      // finishes inline; an agent backend takes longer, so poll up to ~2 min before giving up).
      const { jobId } = await orcaClient.planPreview({ goal: sampleGoal.trim(), prompt });
      for (let i = 0; i < 120; i++) {
        const job = await orcaClient.getPlanJob(jobId);
        if (job.status === 'done') { setPreview(job.phases); break; }
        if (job.status === 'failed') { toast(t.settings.planFailed, 'error'); break; }
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      if (e instanceof OrcaApiError && e.code === 'autopilot_key_missing') toast(t.settings.setApiKeyFirst, 'error');
      else toast(String(e), 'error');
    } finally { setPreviewing(false); }
  };

  const [defExec, setDefExec] = useState('');
  const [defAutonomy, setDefAutonomy] = useState('');
  const [defMaxSessions, setDefMaxSessions] = useState(1);

  // Add / edit model modal state
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingExec, setEditingExec] = useState<string | null>(null);

  const [hiddenPresets, setHiddenPresets] = useState<string[]>([]);

  // Pending delete (drives the ConfirmDialog)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Hermes integration form state
  const [hHome, setHHome] = useState('/var/www/.hermes');
  const [hUrl, setHUrl] = useState('');
  const [hToken, setHToken] = useState('');
  const hermesStatus = useHermesStatus(hHome);
  const hermesInstall = useHermesInstall();

  // Seed the form from the config ONCE. useConfig is stale-while-revalidate, so it refetches on
  // window focus; re-seeding on every refetch would wipe a model the user just added before they
  // hit Save. We seed on first load only — subsequent server updates don't clobber in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (config.data && !seeded.current) {
      seeded.current = true;
      setAllowed(config.data.allowedExecs);
      setCustomModels(config.data.customModels ?? []);
      setHiddenPresets(config.data.hiddenPresets ?? []);
      setModel(config.data.autopilot.model);
      setOverseerModel(config.data.autopilot.overseerModel ?? '');
      setPilotExec(config.data.autopilot.pilotExec ?? '');
      setOverseerExec(config.data.autopilot.overseerExec ?? '');
      setReviewOnDone(config.data.autopilot.reviewOnDone ?? false);
      setReasoningMode((config.data.autopilot.pilotExec || config.data.autopilot.overseerExec) ? 'agents' : 'relay');
      setApiUrl(config.data.autopilot.apiUrl);
      setNotes(config.data.autopilot.notes);
      setPrompt(config.data.autopilot.prompt);
      setProviders(config.data.providers ?? {});
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
    }
  }, [config.data]);

  // Pre-fill Hermes form defaults once on the client.
  useEffect(() => {
    setHUrl(process.env.NEXT_PUBLIC_ORCA_URL ?? window.location.origin);
    const tk = getToken();
    if (tk) setHToken(tk);
  }, []);

  if (config.isLoading) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><LoadingState /></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><ErrorState message={t.common.daemonUnreachable} onRetry={() => config.refetch()} /></ModuleShell>;
  // Administration surface — admins only. A non-admin who deep-links here gets a clear stop.
  if (me.data?.user && !me.data.user.is_admin) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><EmptyState title={t.settings.adminOnly} description={t.settings.adminOnlyDesc} icon={Lock} /></ModuleShell>;

  const apiKeySet = config.data?.autopilot.apiKeySet;

  const resetForm = () => {
    setShowAddForm(false);
    setEditingExec(null);
  };

  // Model changes auto-persist immediately — no separate "save models" step to forget (a two-step
  // add-then-save was a footgun where edits silently vanished on reload). Each handler computes the
  // next state, applies it, and PUTs it in one go. `silent` skips the toast for frequent toggles.
  const persistModels = (next: { allowed?: string[]; customModels?: { label: string; exec: string }[]; hiddenPresets?: string[] }, silent = false) => {
    const allowedExecs = next.allowed ?? allowed;
    const cm = next.customModels ?? customModels;
    const hp = next.hiddenPresets ?? hiddenPresets;
    setAllowed(allowedExecs);
    setCustomModels(cm);
    setHiddenPresets(hp);
    update.mutate(
      { allowedExecs, customModels: cm, hiddenPresets: hp },
      { onSuccess: () => { if (!silent) toast(t.settings.modelsSaved); }, onError: (e) => toast(String(e), 'error') },
    );
  };

  const toggle = (exec: string) =>
    persistModels({ allowed: allowed.includes(exec) ? allowed.filter((e) => e !== exec) : [...allowed, exec] }, true);

  const deleteModel = (exec: string) => {
    const next: { allowed: string[]; customModels?: { label: string; exec: string }[]; hiddenPresets?: string[] } = { allowed: allowed.filter((e) => e !== exec) };
    if (PRESET_EXECS.has(exec)) next.hiddenPresets = hiddenPresets.includes(exec) ? hiddenPresets : [...hiddenPresets, exec];
    else next.customModels = customModels.filter((m) => m.exec !== exec);
    persistModels(next);
    if (editingExec === exec) resetForm();
  };

  const startEdit = (m: { label: string; exec: string }) => {
    setEditingExec(m.exec);
    setShowAddForm(true);
  };

  const saveModel = (m: { label: string; exec: string }) => {
    let nextCustom = customModels, nextAllowed = allowed, nextHidden = hiddenPresets;
    if (editingExec) {
      const original = editingExec;
      if (PRESET_EXECS.has(original)) {
        // Editing a preset hides the original and stores a custom override in its place.
        nextHidden = hiddenPresets.includes(original) ? hiddenPresets : [...hiddenPresets, original];
        nextCustom = [...customModels.filter((x) => x.exec !== m.exec), m];
        const base = allowed.filter((e) => e !== original);
        nextAllowed = base.includes(m.exec) ? base : [...base, m.exec];
      } else {
        nextCustom = customModels.some((x) => x.exec === original) ? customModels.map((x) => (x.exec === original ? m : x)) : [...customModels, m];
        nextAllowed = allowed.map((e) => (e === original ? m.exec : e));
      }
    } else {
      nextCustom = [...customModels, m];
      nextAllowed = allowed.includes(m.exec) ? allowed : [...allowed, m.exec]; // enable new models by default
    }
    persistModels({ allowed: nextAllowed, customModels: nextCustom, hiddenPresets: nextHidden });
    resetForm();
  };

  // Persist only the active mode's fields, and explicitly clear the other backend so the two never
  // coexist (relay clears the execs; agents leave the relay model/key untouched but unused).
  const saveAutopilot = () =>
    update.mutate(
      { autopilot: reasoningMode === 'agents'
        ? { pilotExec, overseerExec, reviewOnDone, notes, prompt }
        : { model, overseerModel, apiUrl, pilotExec: '', overseerExec: '', notes, prompt, ...(apiKey ? { apiKey } : {}) } },
      { onSuccess: () => { toast(t.settings.autopilotSaved); setApiKey(''); }, onError: (e) => toast(String(e), 'error') },
    );

  const saveProviders = () =>
    update.mutate(
      { providers },
      { onSuccess: () => toast(t.settings.providersSaved), onError: (e) => toast(String(e), 'error') },
    );

  const saveDefaults = () =>
    update.mutate(
      { defaults: { exec: defExec, autonomy: defAutonomy, maxSessions: defMaxSessions } },
      { onSuccess: () => toast(t.settings.defaultsSaved), onError: (e) => toast(String(e), 'error') },
    );

  const installHermes = () =>
    hermesInstall.mutate(
      { home: hHome.trim() || undefined, url: hUrl.trim(), token: hToken.trim() },
      {
        onSuccess: () => toast(t.settings.hermesInstalled),
        onError: (e) => toast(String(e), 'error'),
      },
    );

  const SECTIONS: { id: Category; icon: LucideIcon }[] = [
    { id: 'models', icon: Boxes },
    { id: 'autopilot', icon: Bot },
    { id: 'providers', icon: Plug },
    { id: 'defaults', icon: SlidersHorizontal },
    { id: 'hermes', icon: Radio },
  ];

  // 'models' auto-saves on every change, so it has no manual save button. 'hermes' has its own form.
  const saveAction: Record<Exclude<Category, 'hermes' | 'models'>, { label: string; onClick: () => void }> = {
    autopilot: { label: t.settings.saveAutopilot, onClick: saveAutopilot },
    providers: { label: t.settings.saveProviders, onClick: saveProviders },
    defaults: { label: t.settings.saveDefaults, onClick: saveDefaults },
  };
  const active = category === 'hermes' || category === 'models' ? null : saveAction[category];

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
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal}>
        {active && <Button variant="accent" icon={Save} onClick={active.onClick}>{active.label}</Button>}
      </ModuleHeader>

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        {/* Left section nav — sticky on md+, horizontal scroll row on small screens */}
        <nav
          aria-label={t.settings.sectionsNav}
          className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 md:sticky md:top-[57px] md:mx-0 md:w-44 md:flex-col md:overflow-visible md:px-0 md:pb-0"
        >
          {SECTIONS.map(({ id, icon: Icon }) => {
            const isActive = category === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setCategory(id)}
                className={`inline-flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors active:scale-[0.98] md:w-full ${
                  isActive
                    ? 'border-border-strong bg-elevated text-text'
                    : 'border-transparent text-text-muted hover:bg-surface hover:text-text'
                }`}
                style={{ transitionDuration: 'var(--motion-fast)' }}
              >
                <Icon size={16} aria-hidden className={isActive ? 'text-accent' : ''} />
                {t.settings[id]}
              </button>
            );
          })}
        </nav>

        {/* Right content zone — the active category sits here directly, no Section frame */}
        <div className="min-w-0 flex-1">
        {category === 'models' && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models.map((p) => {
                const isCustom = !PRESET_EXECS.has(p.exec);
                return (
                  <div key={p.exec} className="card-interactive group relative flex flex-col gap-3.5 rounded-lg border border-border bg-surface p-5">
                    <div className="absolute right-3 top-3 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100" style={{ transitionDuration: 'var(--motion-fast)' }}>
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
                    <div className="flex items-center justify-between gap-2">
                      <Toggle checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} label={p.label} />
                      <ProviderTag id={execProvider(p.exec)} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4">
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

        {category === 'autopilot' && (
            <div className="flex flex-col gap-4">
              {/* One clear choice: how the planner + overseer reason. Relay (API) OR CLI agents. */}
              <div className="rounded-lg border border-border bg-surface p-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text">{t.settings.backendMode}</span>
                  <HelpTip>{t.settings.backendModeHelp}</HelpTip>
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {reasoningMode === 'relay' ? (
                <>
                  <SettingCard title={t.settings.plannerModel} description={t.settings.plannerModelDesc} icon={Bot}>
                    <ModelInput value={model} onChange={setModel} placeholder={t.settings.plannerPlaceholder} />
                  </SettingCard>
                  <SettingCard title={t.settings.overseerModel} description={t.settings.overseerModelDesc} icon={Eye}>
                    <ModelInput value={overseerModel} onChange={setOverseerModel} placeholder={t.settings.overseerPlaceholder} />
                  </SettingCard>
                  <SettingCard title={t.settings.apiUrl} description={t.settings.apiUrlDesc} icon={Link2}>
                    <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} />
                  </SettingCard>
                  <SettingCard title={t.settings.apiKey} description={apiKeySet ? t.settings.apiKeyDesc : t.settings.apiKeyNotSetDesc} icon={KeyRound}>
                    <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? t.settings.apiKeySetPlaceholder : t.settings.apiKeyPlaceholder} className={inputClass} />
                  </SettingCard>
                </>
              ) : (
                <>
                  <SettingCard title={t.settings.plannerModel} description={t.settings.plannerModelDesc} icon={Bot}>
                    <BackendPicker value={pilotExec} onChange={setPilotExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingCard>
                  <SettingCard title={t.settings.overseerModel} description={t.settings.overseerModelDesc} icon={Eye}>
                    <BackendPicker value={overseerExec} onChange={setOverseerExec} models={models} relayLabel={t.settings.relayOption} allowRelay={false} />
                  </SettingCard>
                  <SettingCard title={t.settings.reviewOnDone} description={t.settings.reviewOnDoneHint} icon={Eye}>
                    <Toggle checked={reviewOnDone} onChange={setReviewOnDone} label={t.settings.reviewOnDone} />
                  </SettingCard>
                </>
              )}
              <SettingCard title={t.settings.notes} description={t.settings.notesDesc} icon={FileText}>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
              </SettingCard>
              <div className="sm:col-span-2 rounded-lg border border-border bg-surface p-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text">{t.settings.plannerPrompt}</span>
                  <HelpTip>{t.settings.plannerPromptHelp}</HelpTip>
                </div>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} spellCheck={false} className={`${inputClass} resize-y font-mono text-xs leading-relaxed`} />

                <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-elevated/40 p-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-text-muted">{t.settings.testPlan}</span>
                  <div className="flex items-center gap-2">
                    <Input value={sampleGoal} onChange={(e) => setSampleGoal(e.target.value)} placeholder={t.settings.sampleGoalPlaceholder} />
                    <Button variant="default" disabled={previewing || !sampleGoal.trim()} onClick={runPreview}>{previewing ? t.settings.planning : t.settings.testPlan}</Button>
                  </div>
                  {preview && (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                      {preview.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 px-3 py-2 text-sm">
                          <span className="w-4 shrink-0 font-mono text-xs text-text-muted">{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-text">{p.title}</span>
                              <span className="shrink-0 rounded border border-border px-1 text-tiny uppercase text-text-muted">{p.type}</span>
                              {p.agent ? <span className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 text-tiny text-accent">{p.agent}</span> : null}
                            </div>
                            {p.details ? <p className="mt-0.5 truncate text-xs text-text-muted">{p.details}</p> : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
              </div>
            </div>
        )}

        {category === 'providers' && (
          <div>
            <p className="mb-4 text-sm text-text-muted">{t.settings.providersDesc}</p>
            <div className="flex flex-col gap-3">
              {PROVIDERS.map((p) => {
                const cur = providers[p.id] ?? { bin: p.binHint, args: '' };
                const set = (patch: Partial<{ bin: string; args: string }>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                return (
                  <div key={p.id} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3 sm:w-44 sm:shrink-0">
                      <ProviderLogo meta={p} alt={t.providers[p.id as keyof typeof t.providers]} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text">{t.providers[p.id as keyof typeof t.providers]}</div>
                        <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
                      </div>
                    </div>
                    <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label={t.settings.binary}>
                        <Input value={cur.bin} placeholder={p.binHint} onChange={(e) => set({ bin: e.target.value })} className="font-mono text-xs" />
                      </Field>
                      <Field label={t.settings.extraArgs}>
                        <Input value={cur.args} placeholder={p.argsHint} onChange={(e) => set({ args: e.target.value })} className="font-mono text-xs" />
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {category === 'defaults' && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SettingCard title={t.settings.executor} description={t.settings.executorDesc} icon={Cpu}>
                {/* Custom picker (not Segmented): each executor shows its model brand icon. The saved
                    default is always shown even if it's not in the model list. */}
                <div role="radiogroup" className="flex flex-wrap gap-1.5">
                  {(models.some((m) => m.exec === defExec) ? models : [...models, { label: defExec, exec: defExec }]).filter((m) => m.exec).map((m) => {
                    const on = defExec === m.exec;
                    return (
                      <button
                        key={m.exec}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={m.label}
                        onClick={() => setDefExec(m.exec)}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
                        style={{ transitionDuration: 'var(--motion-fast)' }}
                      >
                        <ModelIcon name={m.exec} size={15} />{m.label}
                      </button>
                    );
                  })}
                </div>
              </SettingCard>
              <SettingCard title={t.settings.autonomy} description={t.settings.autonomyDesc} icon={Gauge}>
                <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
              </SettingCard>
              <SettingCard title={t.settings.maxSessions} description={t.settings.maxSessionsDesc} icon={Layers}>
                <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} />
              </SettingCard>
            </div>
        )}

        {category === 'hermes' && (
          <div className="flex flex-col gap-4">
            <img
              src="/hermes-banner.png"
              alt="Hermes"
              className="w-full max-w-md self-start rounded-lg border border-border bg-surface object-contain"
            />
            <p className="text-sm text-text-muted">{t.settings.hermesDesc}</p>

            {/* Plugin status — pills up top: red until installed + enabled, then green. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.settings.hermesStatusLine}</span>
              {hermesStatus.isLoading ? (
                <Badge tone="muted">{t.common.loading}</Badge>
              ) : hermesStatus.isError ? (
                <Badge tone="warning">{t.settings.hermesStatusError}</Badge>
              ) : (
                <>
                  <Badge tone={hermesStatus.data?.pluginInstalled ? 'success' : 'danger'}>
                    {hermesStatus.data?.pluginInstalled ? t.settings.hermesStatusInstalled : t.settings.hermesStatusNotInstalled}
                  </Badge>
                  <Badge tone={hermesStatus.data?.enabled ? 'success' : 'danger'}>
                    {hermesStatus.data?.enabled ? t.settings.hermesStatusEnabled : t.settings.hermesStatusDisabled}
                  </Badge>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t.settings.hermesHome}>
                <Input value={hHome} onChange={(e) => setHHome(e.target.value)} className="font-mono text-xs" />
              </Field>
              <Field label={t.settings.hermesUrl}>
                <Input value={hUrl} onChange={(e) => setHUrl(e.target.value)} className="font-mono text-xs" />
              </Field>
              <Field label={t.settings.hermesToken}>
                <Input type="password" value={hToken} onChange={(e) => setHToken(e.target.value)} className="font-mono text-xs" />
              </Field>
            </div>

            <div className="flex flex-col gap-3">
              <Button variant="accent" className="self-start" disabled={hermesInstall.isPending || !hUrl.trim() || !hToken.trim()} onClick={installHermes}>
                {hermesInstall.isPending ? t.settings.hermesInstalling : t.settings.hermesInstall}
              </Button>
              <p className="text-xs text-text-muted">{t.settings.hermesRestartNote}</p>
            </div>
          </div>
        )}
        </div>
      </div>

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
