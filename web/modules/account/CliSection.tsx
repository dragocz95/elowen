'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Eye, SlidersHorizontal } from 'lucide-react';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { SettingCard } from '../../components/ui/SettingCard';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';

/** Account → Orca AI: per-user runtime settings for the embedded brain (web chat + `orca chat`).
 *  Vision fallback + auto-compact. Behavior/personality knobs live in the Personality section, the
 *  primary chat model in Profile — this section owns runtime only. Its own load/save + autosave. */
export function CliSection() {
  const { data, isLoading } = useMyCliSettings();
  const models = useBrainModels();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  // The picker value pairs provider + model; '' = the server default. '::' never appears in ids.
  const [visionSelection, setVisionSelection] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data) {
      setVisionSelection(data.visionModel ? `${data.visionModelProvider ?? ''}::${data.visionModel}` : '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setSeeded(true);
    }
  }, [data]);

  // Auto-persist shortly after any change. Sends only the fields this section owns — the PATCH merges,
  // so the Personality/Profile picks stay untouched.
  const persist = () => {
    const [vProvider, ...vRest] = visionSelection.split('::');
    save.mutate(
      {
        visionModel: visionSelection ? vRest.join('::') : '', visionModelProvider: visionSelection ? (vProvider ?? '') : '',
        autoCompact, autoCompactAt,
      },
      { onError: () => toast(t.cli.saveError, 'error') },
    );
  };
  useAutoSave([visionSelection, autoCompact, autoCompactAt], persist, { ready: seeded });

  if (isLoading || !data) return <LoadingState />;

  const options = models.data ?? [];
  // The picker speaks exec strings; this section stores provider::model — translate at the edges.
  const selectedVisionExec = options.find((o) => `${o.provider}::${o.model}` === visionSelection)?.exec ?? '';

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">{t.cli.intro}</p>

      <SettingCard title={t.cli.visionModelLabel} icon={Eye} description={t.cli.visionModelHint}>
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

      <SettingCard title={t.cli.autoCompact} icon={SlidersHorizontal} description={t.cli.autoCompactHint}>
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
    </div>
  );
}
