'use client';
import { useEffect, useState } from 'react';
import { useConfig } from '../../lib/queries';
import { useUpdateConfig } from '../../lib/mutations';
import { EXEC_PRESETS } from '../../lib/execPresets';
import { useToast } from '../../components/ui/Toast';
import { Panel } from '../../components/ui/Panel';
import { PageHeader } from '../../components/ui/PageHeader';
import { Button } from '../../components/ui/Button';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ModuleShell } from '../../components/shell/ModuleShell';
import '../../modules/settings/theme.css';

export default function SettingsPage() {
  const config = useConfig();
  const update = useUpdateConfig();
  const { toast } = useToast();

  const [allowed, setAllowed] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    if (config.data) {
      setAllowed(config.data.allowedExecs);
      setModel(config.data.autopilot.model);
      setApiUrl(config.data.autopilot.apiUrl);
    }
  }, [config.data]);

  if (config.isLoading) return <ModuleShell moduleId="settings"><Panel><PageHeader title="Settings" /><LoadingState /></Panel></ModuleShell>;
  if (config.isError) return <ModuleShell moduleId="settings"><Panel><PageHeader title="Settings" /><ErrorState message="orca daemon unreachable" onRetry={() => config.refetch()} /></Panel></ModuleShell>;

  const toggle = (exec: string) => setAllowed((prev) => prev.includes(exec) ? prev.filter((e) => e !== exec) : [...prev, exec]);
  const apiKeySet = config.data?.autopilot.apiKeySet;

  return (
    <ModuleShell moduleId="settings">
      <Panel>
        <PageHeader title="Models" />
        <div className="flex flex-col gap-2 p-3">
          {EXEC_PRESETS.map((p) => (
            <label key={p.exec} className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" aria-label={p.label} checked={allowed.includes(p.exec)} onChange={() => toggle(p.exec)} />
              {p.label} <span className="font-mono text-xs text-text-muted">{p.exec}</span>
            </label>
          ))}
          <div><Button variant="accent" onClick={() => update.mutate({ allowedExecs: allowed }, { onSuccess: () => toast('Models saved'), onError: (e) => toast(String(e), 'error') })}>Save models</Button></div>
        </div>
      </Panel>

      <Panel>
        <PageHeader title="Autopilot" />
        <div className="flex flex-col gap-3 p-3 max-w-md">
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-text-muted">Decision model
            <input value={model} onChange={(e) => setModel(e.target.value)} className="bg-surface border border-border rounded-none px-2 py-1 text-sm text-text normal-case" />
          </label>
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-text-muted">OpenAI API URL
            <input value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} className="bg-surface border border-border rounded-none px-2 py-1 text-sm text-text normal-case" />
          </label>
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-text-muted">API key {apiKeySet && <span className="text-accent normal-case">•••• set</span>}
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={apiKeySet ? 'leave blank to keep' : 'paste key'} className="bg-surface border border-border rounded-none px-2 py-1 text-sm text-text normal-case" />
          </label>
          <div><Button variant="accent" onClick={() => update.mutate({ autopilot: { model, apiUrl, ...(apiKey ? { apiKey } : {}) } }, { onSuccess: () => { toast('Autopilot saved'); setApiKey(''); }, onError: (e) => toast(String(e), 'error') })}>Save autopilot</Button></div>
        </div>
      </Panel>
    </ModuleShell>
  );
}
