'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Eye, Gauge, SlidersHorizontal, Zap } from 'lucide-react';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { SettingCard } from '../../components/ui/SettingCard';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings, useMyPermissions, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings, useSaveMyPermissions } from '../../lib/mutations';
import { Pill } from './pills';

const THINKING_LEVELS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Account → Orca AI: per-user runtime settings for the embedded brain (web chat + `orca chat`).
 *  Thinking level + vision fallback + auto-compact; the default model pickers render beside this
 *  section in AccountView. Communication style lives in Personality. Its own load/save + autosave. */
export function CliSection() {
  const { data, isLoading } = useMyCliSettings();
  const models = useBrainModels();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  // The picker value pairs provider + model; '' = the server default. '::' never appears in ids.
  const [visionSelection, setVisionSelection] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data) {
      setVisionSelection(data.visionModel ? `${data.visionModelProvider ?? ''}::${data.visionModel}` : '');
      setThinkingLevel(data.thinkingLevel ?? '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setSeeded(true);
    }
  }, [data]);

  // YOLO default lives in the separate permissions blob (GET/PATCH /auth/me/permissions) — its own
  // query + seed + autosave so flipping it never touches (or restarts through) cli-settings.
  const permissions = useMyPermissions();
  const savePermissions = useSaveMyPermissions();
  const [yolo, setYolo] = useState(false);
  const [yoloSeeded, setYoloSeeded] = useState(false);
  useEffect(() => {
    if (permissions.data) {
      setYolo(permissions.data.yolo);
      setYoloSeeded(true);
    }
  }, [permissions.data]);
  useAutoSave([yolo], () => {
    savePermissions.mutate({ yolo }, { onError: () => toast(t.cli.saveError, 'error') });
  }, { ready: yoloSeeded });

  // Auto-persist shortly after any change. Sends only the fields this section owns — the PATCH merges,
  // so the Personality/default-model picks stay untouched.
  const persist = () => {
    const [vProvider, ...vRest] = visionSelection.split('::');
    save.mutate(
      {
        visionModel: visionSelection ? vRest.join('::') : '', visionModelProvider: visionSelection ? (vProvider ?? '') : '',
        thinkingLevel, autoCompact, autoCompactAt,
      },
      { onError: () => toast(t.cli.saveError, 'error') },
    );
  };
  useAutoSave([visionSelection, thinkingLevel, autoCompact, autoCompactAt], persist, { ready: seeded });

  if (isLoading || !data) return <LoadingState />;

  const options = models.data ?? [];
  // The picker speaks exec strings; this section stores provider::model — translate at the edges.
  const selectedVisionExec = options.find((o) => `${o.provider}::${o.model}` === visionSelection)?.exec ?? '';

  return (
    <div className="flex flex-col gap-4">
      <SettingCard title={t.cli.thinkingLabel} icon={Gauge} description={t.help.cliThinking}>
        <div className="flex flex-wrap gap-1.5">
          {THINKING_LEVELS.map((lv) => (
            <Pill key={lv || 'default'} on={thinkingLevel === lv} onClick={() => setThinkingLevel(lv)}>
              {lv === '' ? t.cli.thinkingDefault : lv}
            </Pill>
          ))}
        </div>
      </SettingCard>

      <SettingCard title={t.cli.visionModelLabel} icon={Eye} description={t.help.cliVisionModel}>
        <ExecutorPicker
          value={selectedVisionExec}
          onChange={(exec) => {
            const o = options.find((x) => x.exec === exec);
            setVisionSelection(o ? `${o.provider}::${o.model}` : '');
          }}
          models={[]}
          kind="brain"
          defaultLabel={t.cli.visionModelDefault}
        />
      </SettingCard>

      <SettingCard title={t.cli.autoCompact} icon={SlidersHorizontal} description={t.help.cliAutoCompact}>
        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-3 text-sm text-text">
            <Toggle checked={autoCompact} onChange={setAutoCompact} label={t.cli.autoCompactToggle} />
            <span>{t.cli.autoCompactToggle}</span>
          </label>
          {autoCompact ? (
            <div className="flex items-center gap-4">
              <span className="shrink-0 text-xs text-text-muted">{t.cli.autoCompactAt}</span>
              <Slider value={autoCompactAt} min={30} max={95} step={5} onChange={setAutoCompactAt} aria-label={t.cli.autoCompactAt} />
              <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{autoCompactAt}%</span>
            </div>
          ) : null}
        </div>
      </SettingCard>

      <SettingCard title={t.cli.yoloTitle} icon={Zap}>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-3 text-sm text-text">
            <Toggle checked={yolo} onChange={setYolo} label={t.cli.yoloToggle} />
            <span>{t.cli.yoloToggle}</span>
          </label>
          {/* Always-visible warning (not a HelpTip): auto-approving tool runs is a security trade-off. */}
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t.cli.yoloWarning}
          </p>
        </div>
      </SettingCard>
    </div>
  );
}
