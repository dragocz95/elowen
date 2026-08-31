'use client';
import { useEffect, useMemo, useState } from 'react';
import { Boxes, LayoutDashboard, MessageSquareQuote, RefreshCw, Server, Sparkles, SquareStack, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Toggle } from '../../components/ui/Toggle';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { ModelCatalogField } from '../../components/ui/ModelCatalogField';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useBrainModels, useDashRecap } from '../../lib/queries';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { elowenClient } from '../../lib/elowenClient';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

/** Settings → Dashboard: the personalized dashboard controls. What renders (recap strip, agent-written
 *  greeting and quick-action pills, continue pills), whether the daily digest generates at all, and
 *  which model writes it. The digest model inherits its key/endpoint from the referenced brain provider
 *  (like the memory models); unset, it falls back to the memory categorization model. */
export function DashboardSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const { data: brainModels } = useBrainModels();
  const recap = useDashRecap();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [recapEnabled, setRecapEnabled] = useState(true);
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [greetingEnabled, setGreetingEnabled] = useState(false);
  const [pillsEnabled, setPillsEnabled] = useState(false);
  const [continueEnabled, setContinueEnabled] = useState(true);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [seeded, setSeeded] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Seed the form once from the persisted config; edits auto-persist shortly after.
  useEffect(() => {
    const block = config?.dashboard;
    if (block && !seeded) {
      setRecapEnabled(block.recapEnabled);
      setDigestEnabled(block.digestEnabled);
      setGreetingEnabled(block.greetingEnabled);
      setPillsEnabled(block.pillsEnabled);
      setContinueEnabled(block.continueEnabled);
      setProviderId(block.digest.providerId);
      setModel(block.digest.model);
      setSeeded(true);
    }
  }, [config, seeded]);

  const catalog = useMemo(() => {
    const opts = (brainModels ?? []).filter((m) => !providerId || m.provider === providerId);
    return Array.from(new Set(opts.map((m) => m.model)));
  }, [brainModels, providerId]);

  const save = async () => {
    await elowenClient.updateConfig({
      dashboard: {
        recapEnabled, digestEnabled, greetingEnabled, pillsEnabled, continueEnabled,
        digest: { providerId: providerId.trim(), model: model.trim() },
      },
    });
    // The recap route reads config live; refetch so the dashboard reflects the change immediately.
    void queryClient.invalidateQueries({ queryKey: ['dash-recap'] });
    void queryClient.invalidateQueries({ queryKey: ['config'] });
  };
  const { status, retry } = useAutoSaveStatus(
    [recapEnabled, digestEnabled, greetingEnabled, pillsEnabled, continueEnabled, providerId, model],
    save,
    { ready: seeded },
  );
  useEffect(() => {
    onSaveState?.('dashboard', status, status === 'error' ? retry : undefined);
  }, [onSaveState, retry, status]);

  if (!config) return <LoadingState />;

  const providers = config.brain?.providers ?? [];
  const digestStatus = recap.data?.digest?.status;
  const statusBadge = digestStatus === 'ready'
    ? <Badge tone="accent">{t.settings.dashboardSection.statusReady}</Badge>
    : digestStatus === 'generating'
      ? <Badge>{t.settings.dashboardSection.statusGenerating}</Badge>
      : <Badge>{t.settings.dashboardSection.statusUnavailable}</Badge>;

  const onRegenerate = () => {
    setRegenerating(true);
    void elowenClient.dashRecapRegenerate()
      .then(() => {
        toast(t.settings.dashboardSection.regenerated);
        void queryClient.invalidateQueries({ queryKey: ['dash-recap'] });
      })
      .catch(() => toast(t.settings.dashboardSection.regenerateError, 'error'))
      .finally(() => setRegenerating(false));
  };

  return (
    <SettingsGroup title={t.settings.dashboardSection.title} icon={LayoutDashboard}>
      <SettingsRow
        label={t.settings.dashboardSection.recap}
        description={t.settings.dashboardSection.recapDesc}
        icon={LayoutDashboard}
        control={<Toggle checked={recapEnabled} onChange={setRecapEnabled} label={t.settings.dashboardSection.recap} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.digest}
        description={t.settings.dashboardSection.digestDesc}
        icon={Sparkles}
        status={statusBadge}
        actions={
          <Button variant="ghost" size="sm" icon={RefreshCw} disabled={regenerating || !digestEnabled} onClick={onRegenerate}>
            {t.settings.dashboardSection.regenerate}
          </Button>
        }
        control={<Toggle checked={digestEnabled} onChange={setDigestEnabled} label={t.settings.dashboardSection.digest} disabled={!recapEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.greeting}
        description={t.settings.dashboardSection.greetingDesc}
        icon={MessageSquareQuote}
        control={<Toggle checked={greetingEnabled} onChange={setGreetingEnabled} label={t.settings.dashboardSection.greeting} disabled={!recapEnabled || !digestEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.pills}
        description={t.settings.dashboardSection.pillsDesc}
        icon={SquareStack}
        control={<Toggle checked={pillsEnabled} onChange={setPillsEnabled} label={t.settings.dashboardSection.pills} disabled={!recapEnabled || !digestEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.continue}
        description={t.settings.dashboardSection.continueDesc}
        icon={Undo2}
        control={<Toggle checked={continueEnabled} onChange={setContinueEnabled} label={t.settings.dashboardSection.continue} disabled={!recapEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.provider}
        description={t.settings.dashboardSection.modelFallback}
        icon={Server}
        control={
          <ChoiceField
            title={t.settings.dashboardSection.provider}
            options={[{ value: '', label: t.settings.dashboardSection.providerInherit }, ...providers.map((p) => ({ value: p.id, label: p.label }))]}
            value={providerId}
            onChange={(next) => { setProviderId(next); if (next !== providerId) setModel(''); }}
            picker="always"
          />
        }
      />
      {providerId ? (
        <SettingsRow
          label={t.settings.dashboardSection.model}
          description={t.settings.dashboardSection.modelDesc}
          icon={Boxes}
          control={<ModelCatalogField value={model} onChange={setModel} catalog={catalog} title={t.settings.dashboardSection.model} subtitle={t.settings.dashboardSection.modelDesc} />}
        />
      ) : null}
    </SettingsGroup>
  );
}
