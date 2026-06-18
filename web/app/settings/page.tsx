'use client';
import { useEffect, useState } from 'react';
import { Save, Boxes, Bot, SlidersHorizontal, Plus, X, Pencil, Plug, type LucideIcon } from 'lucide-react';
import { PROVIDERS, ProviderLogo } from '../../modules/settings/providers';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { orcaClient, OrcaApiError } from '../../lib/orcaClient';
import { EXEC_PRESETS, allModels } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { PageHeader } from '../../components/ui/PageHeader';
import { Section } from '../../components/ui/Section';
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
const CATEGORIES: { id: Category; label: string; icon: LucideIcon }[] = [
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'defaults', label: 'Defaults', icon: SlidersHorizontal },
];

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [category, setCategory] = useState<Category>('models');

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [model, setModel] = useState('');
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
      if (e instanceof OrcaApiError && e.code === 'autopilot_key_missing') toast('Set the autopilot API key first', 'error');
      else toast(String(e), 'error');
    } finally { setPreviewing(false); }
  };

  const [defExec, setDefExec] = useState('');
  const [defAutonomy, setDefAutonomy] = useState('');
  const [defMaxSessions, setDefMaxSessions] = useState(1);

  // Add / edit model form state
  const [addLabel, setAddLabel] = useState('');
  const [addExec, setAddExec] = useState('');
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
      setApiUrl(config.data.autopilot.apiUrl);
      setNotes(config.data.autopilot.notes);
      setPrompt(config.data.autopilot.prompt);
      setProviders(config.data.providers ?? {});
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
    }
  }, [config.data]);

  if (config.isLoading) return <ModuleShell moduleId="settings"><PageHeader title={t.page.settings} /><LoadingState /></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><PageHeader title={t.page.settings} /><ErrorState message="orca daemon unreachable" onRetry={() => config.refetch()} /></ModuleShell>;

  const toggle = (exec: string) => setAllowed((prev) => prev.includes(exec) ? prev.filter((e) => e !== exec) : [...prev, exec]);
  const apiKeySet = config.data?.autopilot.apiKeySet;

  const resetForm = () => {
    setShowAddForm(false);
    setEditingExec(null);
    setAddLabel('');
    setAddExec('');
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
    setAddLabel(m.label);
    setAddExec(m.exec);
    setShowAddForm(true);
  };

  const submitModel = () => {
    const label = addLabel.trim();
    const exec = addExec.trim();
    if (!label || !exec) return;
    if (editingExec) {
      const original = editingExec;
      setCustomModels((prev) => prev.map((m) => (m.exec === original ? { label, exec } : m)));
      setAllowed((prev) => prev.map((e) => (e === original ? exec : e)));
    } else {
      setCustomModels((prev) => [...prev, { label, exec }]);
    }
    resetForm();
  };

  const saveModels = () =>
    update.mutate(
      { allowedExecs: allowed, customModels, hiddenPresets },
      { onSuccess: () => toast('Models saved'), onError: (e) => toast(String(e), 'error') },
    );

  const models = allModels(customModels, hiddenPresets);
  const deleteTarget = models.find((m) => m.exec === pendingDelete);

  return (
    <ModuleShell moduleId="settings">
      <div className="flex w-full flex-col gap-6">
        <PageHeader title={t.page.settings} />

        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(({ id, label, icon: Icon }) => {
            const active = category === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(id)}
                className={`inline-flex items-center gap-2.5 rounded-lg border px-5 py-3 text-sm font-medium transition-colors ${
                  active
                    ? 'border-accent bg-accent text-white'
                    : 'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text'
                }`}
                style={{ transitionDuration: 'var(--motion-base)' }}
              >
                <Icon size={16} aria-hidden />
                {label}
              </button>
            );
          })}
        </div>

        {category === 'models' && (
          <Section
            title="Models"
            icon={Boxes}
            actions={
              <Button variant="accent" icon={Save} onClick={saveModels}>
                Save models
              </Button>
            }
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models.map((p) => {
                const isCustom = !PRESET_EXECS.has(p.exec);
                return (
                  <div key={p.exec} className="group relative">
                    <div className="absolute right-3 top-3 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100" style={{ transitionDuration: 'var(--motion-fast)' }}>
                      {isCustom && (
                        <button
                          type="button"
                          aria-label={`Edit ${p.exec}`}
                          title={`Edit ${p.exec}`}
                          onClick={() => startEdit(p)}
                          className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface text-text-muted transition-colors hover:border-border-strong hover:text-text"
                          style={{ transitionDuration: 'var(--motion-fast)' }}
                        >
                          <Pencil size={13} aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`Delete ${p.exec}`}
                        title={`Delete ${p.exec}`}
                        onClick={() => setPendingDelete(p.exec)}
                        className="flex h-6 w-6 items-center justify-center rounded-md border border-danger/60 bg-surface text-danger transition-colors hover:bg-danger hover:text-white"
                        style={{ transitionDuration: 'var(--motion-fast)' }}
                      >
                        <X size={13} aria-hidden />
                      </button>
                    </div>
                    <SettingCard title={p.label} description={p.exec}>
                      <Toggle checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} label={p.label} />
                    </SettingCard>
                  </div>
                );
              })}
            </div>

            <div className="mt-4">
              {showAddForm ? (
                <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 sm:flex-row sm:items-end">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-text-muted">Label</span>
                    <input
                      value={addLabel}
                      onChange={(e) => setAddLabel(e.target.value)}
                      placeholder="My Model"
                      className={inputClass}
                      aria-label={editingExec ? 'Edit model label' : 'New model label'}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-text-muted">Exec</span>
                    <input
                      value={addExec}
                      onChange={(e) => setAddExec(e.target.value)}
                      placeholder="provider/model-name"
                      className={inputClass}
                      aria-label={editingExec ? 'Edit model exec' : 'New model exec'}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="accent" icon={editingExec ? Save : Plus} onClick={submitModel} disabled={!addLabel.trim() || !addExec.trim()}>
                      {editingExec ? 'Save' : 'Add'}
                    </Button>
                    <Button variant="ghost" onClick={resetForm}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" icon={Plus} onClick={() => setShowAddForm(true)}>
                  Add model
                </Button>
              )}
            </div>
          </Section>
        )}

        {category === 'autopilot' && (
          <Section
            title="Autopilot"
            icon={Bot}
            actions={
              <Button variant="accent" icon={Save} onClick={() => update.mutate({ autopilot: { model, apiUrl, notes, prompt, ...(apiKey ? { apiKey } : {}) } }, { onSuccess: () => { toast('Autopilot saved'); setApiKey(''); }, onError: (e) => toast(String(e), 'error') })}>
                Save autopilot
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingCard title="Decision model" description="LLM the autopilot uses to plan">
                <input value={model} onChange={(e) => setModel(e.target.value)} className={inputClass} />
              </SettingCard>
              <SettingCard title="OpenAI API URL" description="OpenAI-compatible endpoint">
                <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className={inputClass} />
              </SettingCard>
              <SettingCard title="API key" description={apiKeySet ? 'A key is set — leave blank to keep' : 'Stored server-side, never returned'}>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? '•••• set' : 'paste key'} className={inputClass} />
              </SettingCard>
              <SettingCard title="Notes" description="Guidance the autopilot follows">
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
              </SettingCard>
              <div className="sm:col-span-2 rounded-lg border border-border bg-surface p-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <span className="text-sm font-medium text-text">Planner prompt</span>
                  <HelpTip>
                    Template the Pilot uses to decompose a goal into phases. Use the
                    <span className="mx-1 rounded bg-elevated px-1 font-mono text-text">{'{{goal}}'}</span>
                    placeholder — it is replaced with the goal you enter. The model must return a JSON array of
                    <span className="font-mono"> {'{title, type, agent}'}</span> objects.
                  </HelpTip>
                </div>
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} spellCheck={false} className={`${inputClass} resize-y font-mono text-xs leading-relaxed`} />

                <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-elevated/40 p-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-text-muted">Test plan</span>
                  <div className="flex items-center gap-2">
                    <Input value={sampleGoal} onChange={(e) => setSampleGoal(e.target.value)} placeholder="A sample goal to test this prompt…" />
                    <Button variant="default" disabled={previewing || !sampleGoal.trim()} onClick={runPreview}>{previewing ? 'Planning…' : 'Test plan'}</Button>
                  </div>
                  {preview && (
                    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                      {preview.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 px-3 py-2 text-sm">
                          <span className="w-4 shrink-0 font-mono text-xs text-text-muted">{i + 1}</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-text">{p.title}</span>
                              <span className="shrink-0 rounded border border-border px-1 text-[10px] uppercase text-text-muted">{p.type}</span>
                              {p.agent ? <span className="shrink-0 rounded-md border border-accent/40 bg-accent/10 px-1.5 text-[10px] text-accent">{p.agent}</span> : null}
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
          </Section>
        )}

        {category === 'providers' && (
          <Section
            title="Providers"
            icon={Plug}
            actions={
              <Button variant="accent" icon={Save} onClick={() => update.mutate({ providers }, { onSuccess: () => toast('Providers saved'), onError: (e) => toast(String(e), 'error') })}>
                Save providers
              </Button>
            }
          >
            <p className="mb-4 text-sm text-text-muted">Where each agent CLI lives and any extra flags passed when orca spawns it. Leave the binary as-is to use it from <span className="font-mono text-text">$PATH</span>.</p>
            <div className="flex flex-col gap-3">
              {PROVIDERS.map((p) => {
                const cur = providers[p.id] ?? { bin: p.binHint, args: '' };
                const set = (patch: Partial<{ bin: string; args: string }>) => setProviders((prev) => ({ ...prev, [p.id]: { ...cur, ...patch } }));
                return (
                  <div key={p.id} className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 sm:flex-row sm:items-center">
                    <div className="flex items-center gap-3 sm:w-44 sm:shrink-0">
                      <ProviderLogo meta={p} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-text">{p.label}</div>
                        <div className="font-mono text-[11px] text-text-muted">{p.id}</div>
                      </div>
                    </div>
                    <div className="grid flex-1 gap-3 sm:grid-cols-2">
                      <Field label="Binary">
                        <Input value={cur.bin} placeholder={p.binHint} onChange={(e) => set({ bin: e.target.value })} className="font-mono text-xs" />
                      </Field>
                      <Field label="Extra args">
                        <Input value={cur.args} placeholder={p.argsHint} onChange={(e) => set({ args: e.target.value })} className="font-mono text-xs" />
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {category === 'defaults' && (
          <Section
            title="Defaults"
            icon={SlidersHorizontal}
            actions={
              <Button variant="accent" icon={Save} onClick={() => update.mutate({ defaults: { exec: defExec, autonomy: defAutonomy, maxSessions: defMaxSessions } }, { onSuccess: () => toast('Defaults saved'), onError: (e) => toast(String(e), 'error') })}>
                Save defaults
              </Button>
            }
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <SettingCard title="Executor" description="Default agent for new launches">
                <Segmented options={EXEC_PRESETS.map((p) => ({ value: p.exec, label: p.exec }))} value={defExec} onChange={setDefExec} />
              </SettingCard>
              <SettingCard title="Autonomy" description="Default mission autonomy level">
                <Segmented options={['L0', 'L1', 'L2', 'L3'].map((l) => ({ value: l, label: l }))} value={defAutonomy} onChange={setDefAutonomy} />
              </SettingCard>
              <SettingCard title="Max sessions" description="Concurrent agents per mission">
                <input type="number" min={1} value={defMaxSessions} onChange={(e) => setDefMaxSessions(Number(e.target.value))} className={inputClass} />
              </SettingCard>
            </div>
          </Section>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete model"
        description={deleteTarget ? `Remove ${deleteTarget.label} (${deleteTarget.exec}) from your models? Save models to persist this change.` : undefined}
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) deleteModel(pendingDelete);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </ModuleShell>
  );
}
