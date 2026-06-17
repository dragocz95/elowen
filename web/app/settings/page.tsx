'use client';
import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { EXEC_PRESETS } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { PageHeader } from '../../components/ui/PageHeader';
import { Section } from '../../components/ui/Section';
import { Button } from '../../components/ui/Button';
import { Toggle } from '../../components/ui/Toggle';
import { Segmented } from '../../components/ui/Segmented';
import { SettingCard } from '../../components/ui/SettingCard';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';

const inputClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-text-muted transition-colors focus:border-accent';

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();

  const [allowed, setAllowed] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [notes, setNotes] = useState('');

  const [defExec, setDefExec] = useState('');
  const [defAutonomy, setDefAutonomy] = useState('');
  const [defMaxSessions, setDefMaxSessions] = useState(1);

  useEffect(() => {
    if (config.data) {
      setAllowed(config.data.allowedExecs);
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

  return (
    <ModuleShell moduleId="settings">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <PageHeader title="Settings" />

        <Section
          title="Models"
          actions={
            <Button variant="accent" icon={Save} onClick={() => update.mutate({ allowedExecs: allowed }, { onSuccess: () => toast('Models saved'), onError: (e) => toast(String(e), 'error') })}>
              Save models
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {EXEC_PRESETS.map((p) => (
              <SettingCard key={p.exec} title={p.label} description={p.exec}>
                <Toggle checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} label={p.label} />
              </SettingCard>
            ))}
          </div>
        </Section>

        <Section
          title="Autopilot"
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
            <SettingCard title="Notes" description="Guidance the autopilot follows" icon={undefined}>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputClass} resize-none`} />
            </SettingCard>
          </div>
        </Section>

        <Section
          title="Defaults"
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
      </div>
    </ModuleShell>
  );
}
