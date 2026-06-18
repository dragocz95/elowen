'use client';
import { useEffect, useState } from 'react';
import { Save, Boxes, Bot, SlidersHorizontal, Plus, X, Pencil, Plug, type LucideIcon } from 'lucide-react';
import { PROVIDERS, ProviderLogo, ProviderTag } from '../../modules/settings/providers';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ModelModal } from '../../modules/settings/ModelModal';
import { execProvider, execModel } from '../../lib/modelProvider';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';
import { EXEC_PRESETS, allModels } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingCard } from '../../components/ui/SettingCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { HelpTip } from '../../components/ui/HelpTip';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';
import { useTranslation } from '../../lib/i18n';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

const PRESET_EXECS = new Set(EXEC_PRESETS.map((p) => p.exec));

type Category = 'models' | 'autopilot' | 'providers' | 'defaults';

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [category, setCategory] = useState<Category>('models');

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [model, setModel] = useState('');
  const [overseerModel, setOverseerModel] = useState('');
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
      const r = await orcaClient.planPreview({ goal: sampleGoal.trim(), prompt });
      setPreview(r.phases);
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

  useEffect(() => {
    if (config.data) {
      setAllowed(config.data.allowedExecs);
      setCustomModels(config.data.customModels ?? []);
      setHiddenPresets(config.data.hiddenPresets ?? []);
      setModel(config.data.autopilot.model);
      setOverseerModel(config.data.autopilot.overseerModel ?? '');
      setApiUrl(config.data.autopilot.apiUrl);
      setNotes(config.data.autopilot.notes);
      setPrompt(config.data.autopilot.prompt);
      setProviders(config.data.providers ?? {});
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
    }
  }, [config.data]);

  if (config.isLoading) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><LoadingState /></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><ModuleHeader title={t.page.settings} icon={SlidersHorizontal} /><ErrorState message={t.common.daemonUnreachable} onRetry={() => config.refetch()} /></ModuleShell>;

  const toggle = (exec: string) => setAllowed((prev) => prev.includes(exec) ? prev.filter((e) => e !== exec) : [...prev, exec]);
  const apiKeySet = config.data?.autopilot.apiKeySet;

  const resetForm = () => {
    setShowAddForm(false);
    setEditingExec(null);
  };

  const deleteModel = (exec: string) => {
    if (PRESET_EXECS.has(exec)) {
      setHiddenPresets((prev) => (prev.includes(exec) ? prev : [...prev, exec]));
    } else {
      setCustomModels((prev) => prev.filter((m) => m.exec !== exec));
    }
    setAllowed((prev) => prev.filter((e) => e !== exec));
    if (editingExec === exec) resetForm();
  };

  const startEdit = (m: { label: string; exec: string }) => {
    setEditingExec(m.exec);
    setShowAddForm(true);
  };

  const saveModel = (m: { label: string; exec: string }) => {
    if (editingExec) {
      const original = editingExec;
      if (PRESET_EXECS.has(original)) {
        // Editing a preset hides the original and stores a custom override in its place.
        setHiddenPresets((prev) => (prev.includes(original) ? prev : [...prev, original]));
        setCustomModels((prev) => [...prev.filter((x) => x.exec !== m.exec), m]);
        setAllowed((prev) => { const base = prev.filter((e) => e !== original); return base.includes(m.exec) ? base : [...base, m.exec]; });
      } else {
        setCustomModels((prev) => prev.some((x) => x.exec === original) ? prev.map((x) => (x.exec === original ? m : x)) : [...prev, m]);
        setAllowed((prev) => prev.map((e) => (e === original ? m.exec : e)));
      }
    } else {
      setCustomModels((prev) => [...prev, m]);
      setAllowed((prev) => (prev.includes(m.exec) ? prev : [...prev, m.exec])); // enable new models by default
    }
    resetForm();
  };

  const saveModels = () =>
    update.mutate(
      { allowedExecs: allowed, customModels, hiddenPresets },
      { onSuccess: () => toast(t.settings.modelsSaved), onError: (e) => toast(String(e), 'error') },
    );

  const saveAutopilot = () =>
    update.mutate(
      { autopilot: { model, overseerModel, apiUrl, notes, prompt, ...(apiKey ? { apiKey } : {}) } },
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

  const SECTIONS: { id: Category; icon: LucideIcon }[] = [
    { id: 'models', icon: Boxes },
    { id: 'autopilot', icon: Bot },
    { id: 'providers', icon: Plug },
    { id: 'defaults', icon: SlidersHorizontal },
  ];

  const saveAction: Record<Category, { label: string; onClick: () => void }> = {
    models: { label: t.settings.saveModels, onClick: saveModels },
    autopilot: { label: t.settings.saveAutopilot, onClick: saveAutopilot },
    providers: { label: t.settings.saveProviders, onClick: saveProviders },
    defaults: { label: t.settings.saveDefaults, onClick: saveDefaults },
  };
  const active = saveAction[category];

  const models = allModels(customModels, hiddenPresets);
  const deleteTarget = models.find((m) => m.exec === pendingDelete);

  return (
    <ModuleShell moduleId="settings">
      <ModuleHeader title={t.page.settings} icon={SlidersHorizontal}>
        <Button variant="accent" icon={Save} onClick={active.onClick}>{active.label}</Button>
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
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            onClose={resetForm}
            onSave={saveModel}
          />
        )}

        {category === 'autopilot' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingCard title={t.settings.plannerModel} description={t.settings.plannerModelDesc}>
                <input value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} placeholder={t.settings.plannerPlaceholder} />
              </SettingCard>
              <SettingCard title={t.settings.overseerModel} description={t.settings.overseerModelDesc}>
                <input value={overseerModel} onChange={(e) => setOverseerModel(e.target.value)} className={inputClass} placeholder={t.settings.overseerPlaceholder} />
              </SettingCard>
              <SettingCard title={t.settings.apiUrl} description={t.settings.apiUrlDesc}>
                <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} />
              </SettingCard>
              <SettingCard title={t.settings.apiKey} description={apiKeySet ? t.settings.apiKeyDesc : t.settings.apiKeyNotSetDesc}>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? t.settings.apiKeySetPlaceholder : t.settings.apiKeyPlaceholder} className={inputClass} />
              </SettingCard>
              <SettingCard title={t.settings.notes} description={t.settings.notesDesc}>
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
                    <div className="grid flex-1 gap-3 sm:grid-cols-2">
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
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingCard title={t.settings.executor} description={t.settings.executorDesc}>
                <Segmented options={EXEC_PRESETS.map((p) => ({ value: p.exec, label: p.exec }))} value={defExec} onChange={setDefExec} />
              </SettingCard>
              <SettingCard title={t.settings.autonomy} description={t.settings.autonomyDesc}>
                <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
              </SettingCard>
              <SettingCard title={t.settings.maxSessions} description={t.settings.maxSessionsDesc}>
                <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} />
              </SettingCard>
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
