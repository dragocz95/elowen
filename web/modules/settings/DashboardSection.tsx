'use client';
import { useEffect, useState } from 'react';
import { Boxes, LayoutDashboard, MessageSquareQuote, RefreshCw, Repeat, Sparkles, SquareStack, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Toggle } from '../../components/ui/Toggle';
import { ChoiceField } from '../../components/ui/ChoiceField';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useConfig, useCategorizationSettings, useDashRecap } from '../../lib/queries';
import { resolveDigestRoute } from '../../lib/modelRoles';
import { useUpdateConfig } from '../../lib/mutations';
import { elowenClient } from '../../lib/elowenClient';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';
import { rowAnchor } from '../../lib/rowAnchors';

/** Refresh rates offered for the digest. Presets rather than a free number: what matters is the shape
 *  of the day (once, twice, every few hours), and the daemon clamps anything outside 1–24 anyway. */
const DIGEST_PER_DAY_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24] as const;

/** Settings → Recap: the personalized dashboard controls. What renders (recap strip, agent-written
 *  greeting and quick-action pills, continue pills) and how often the daily digest refreshes.
 *
 *  WHICH MODEL writes the digest is a model role, not a dashboard setting, and lives in Settings →
 *  Models with the other roles it inherits from. This section keeps a read-only row stating the answer
 *  and linking there, so nothing has to be walked to learn it. */
export function DashboardSection({ onSaveState, onOpenSection }: {
  onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void;
  /** Switch the settings deck to another core section (the cross-link to the model roles). */
  onOpenSection?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { data: config } = useConfig();
  const { data: categorization } = useCategorizationSettings();
  const recap = useDashRecap();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [recapEnabled, setRecapEnabled] = useState(true);
  const [digestEnabled, setDigestEnabled] = useState(true);
  const [greetingEnabled, setGreetingEnabled] = useState(false);
  const [pillsEnabled, setPillsEnabled] = useState(false);
  const [continueEnabled, setContinueEnabled] = useState(true);
  const [perDay, setPerDay] = useState(1);
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
      setPerDay(block.digestPerDay ?? 1);
      setSeeded(true);
    }
  }, [config, seeded]);

  // `digest` is deliberately absent from the patch: the config block merges field by field, so leaving
  // it out preserves whatever Settings → Models wrote — this section is no longer one of its writers.
  const save = async () => {
    await updateConfig.mutateAsync({
      dashboard: {
        recapEnabled, digestEnabled, greetingEnabled, pillsEnabled, continueEnabled,
        digestPerDay: perDay,
      },
    });
    // The recap route reads config live; refetch so the dashboard reflects the change immediately.
    void queryClient.invalidateQueries({ queryKey: ['dash-recap'] });
    void queryClient.invalidateQueries({ queryKey: ['config'] });
  };
  const { status, retry } = useAutoSaveStatus(
    [recapEnabled, digestEnabled, greetingEnabled, pillsEnabled, continueEnabled, perDay],
    save,
    { ready: seeded },
  );
  useEffect(() => {
    onSaveState?.('dashboard', status, status === 'error' ? retry : undefined);
  }, [onSaveState, retry, status]);

  if (!config) return <LoadingState />;

  // What the digest ACTUALLY runs on, through the shared helper that mirrors the daemon's rule. BOTH
  // halves of a pair decide, so a half-set stored digest pair reads as inherited here exactly as the
  // runtime treats it — `digest.model || categorization.model` used to report the orphaned half instead.
  const digestRoute = resolveDigestRoute(
    { providerId: config.dashboard?.digest.providerId, model: config.dashboard?.digest.model },
    { providerId: categorization?.providerId, model: categorization?.model },
  );
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
        rowId={rowAnchor('settings.dashboardSection.recap')}
        description={t.settings.dashboardSection.recapDesc}
        icon={LayoutDashboard}
        control={<Toggle checked={recapEnabled} onChange={setRecapEnabled} label={t.settings.dashboardSection.recap} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.digest}
        rowId={rowAnchor('settings.dashboardSection.digest')}
        description={t.settings.dashboardSection.digestDesc}
        icon={Sparkles}
        // Three trailing values (state badge, regenerate action, switch) do not share a phone's value
        // column: an `inline` record keeps them on ONE non-wrapping line at every width, so the badge and
        // the button overran the label. Same shape and same declaration as the embedding provider record.
        trailingLayout="stack"
        status={statusBadge}
        actions={
          <Button variant="ghost" size="sm" icon={RefreshCw} disabled={regenerating || !digestEnabled} onClick={onRegenerate}>
            {t.settings.dashboardSection.regenerate}
          </Button>
        }
        control={<Toggle checked={digestEnabled} onChange={setDigestEnabled} label={t.settings.dashboardSection.digest} disabled={!recapEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.perDay}
        rowId={rowAnchor('settings.dashboardSection.perDay')}
        description={t.settings.dashboardSection.perDayDesc}
        icon={Repeat}
        control={
          <ChoiceField
            title={t.settings.dashboardSection.perDay}
            options={DIGEST_PER_DAY_CHOICES.map((n) => ({
              value: String(n),
              label: t.settings.dashboardSection.perDayOption.replace('{n}', String(n)),
            }))}
            value={String(perDay)}
            onChange={(next) => setPerDay(Number(next))}
            picker="always"
          />
        }
      />
      <SettingsRow
        label={t.settings.dashboardSection.greeting}
        rowId={rowAnchor('settings.dashboardSection.greeting')}
        description={t.settings.dashboardSection.greetingDesc}
        icon={MessageSquareQuote}
        control={<Toggle checked={greetingEnabled} onChange={setGreetingEnabled} label={t.settings.dashboardSection.greeting} disabled={!recapEnabled || !digestEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.pills}
        rowId={rowAnchor('settings.dashboardSection.pills')}
        description={t.settings.dashboardSection.pillsDesc}
        icon={SquareStack}
        control={<Toggle checked={pillsEnabled} onChange={setPillsEnabled} label={t.settings.dashboardSection.pills} disabled={!recapEnabled || !digestEnabled} />}
      />
      <SettingsRow
        label={t.settings.dashboardSection.continue}
        rowId={rowAnchor('settings.dashboardSection.continue')}
        description={t.settings.dashboardSection.continueDesc}
        icon={Undo2}
        control={<Toggle checked={continueEnabled} onChange={setContinueEnabled} label={t.settings.dashboardSection.continue} disabled={!recapEnabled} />}
      />
      {/* Read-only: which model writes the digest is a model ROLE, chosen next to the roles it inherits
          from. Stating the answer here and linking there is what keeps the reader from walking. */}
      <SettingsRow
        label={t.settings.dashboardSection.model}
        rowId={rowAnchor('settings.dashboardSection.model')}
        description={t.settings.dashboardSection.modelDesc}
        icon={Boxes}
        status={(
          <span className="flex min-w-0 items-center gap-2">
            {digestRoute.route && digestRoute.inherited ? <Badge>{t.settings.modelRoles.inherited}</Badge> : null}
            <span className="truncate font-mono">{digestRoute.route?.model ?? '—'}</span>
          </span>
        )}
        actions={(
          <Button variant="ghost" size="sm" icon={Boxes} onClick={() => onOpenSection?.('models')}>
            {t.settings.dashboardSection.modelLink}
          </Button>
        )}
      />
    </SettingsGroup>
  );
}
