'use client';
import { useEffect, useState } from 'react';
import { Save, Boxes, Bot, SlidersHorizontal, Plus, X, Pencil, type LucideIcon } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { EXEC_PRESETS, allModels } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { PageHeader } from '../../components/ui/PageHeader';
import { Section } from '../../components/ui/Section';
import { Button } from '../../components/ui/Button';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingCard } from '../../components/ui/SettingCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

const PRESET_EXECS = new Set(EXEC_PRESETS.map((p) => p.exec));

type Category = 'models' | 'autopilot' | 'defaults';
const CATEGORIES: { id: Category; label: string; icon: LucideIcon }[] = [
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'autopilot', label: 'Autopilot', icon: Bot },
  { id: 'defaults', label: 'Defaults', icon: SlidersHorizontal },
];

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();

  const [category, setCategory] = useState<Category>('models');

  const [allowed, setAllowed] = useState<string[]>([]);
  const [customModels, setCustomModels] = useState<{ label: string; exec: string }[]>([]);
  const [model, setModel] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [notes, setNotes] = useState('');

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
      setDefExec(config.data.defaults.exec);
      setDefAutonomy(config.data.defaults.autonomy);
      setDefMaxSessions(config.data.defaults.maxSessions);
    }
  }, [config.data]);

  if (config.isLoading) return <ModuleShell moduleId="settings"><PageHeader title="Settings" /><LoadingState /></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><PageHeader title="Settings" /><ErrorState message="orca daemon unreachable" onRetry={() => config.refetch()} /></ModuleShell>;

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
        <PageHeader title="Settings" />

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
              <Button variant="accent" icon={Save} onClick={() => update.mutate({ autopilot: { model, apiUrl, notes, ...(apiKey ? { apiKey } : {}) } }, { onSuccess: () => { toast('Autopilot saved'); setApiKey(''); }, onError: (e) => toast(String(e), 'error') })}>
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
