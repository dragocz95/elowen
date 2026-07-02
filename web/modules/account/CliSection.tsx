'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Cpu, SlidersHorizontal } from 'lucide-react';
import { SettingCard } from '../../components/ui/SettingCard';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';

/** Account → CLI: per-user settings for the Orca brain (`orca chat`). Model override + auto-compact,
 *  mirroring the self-contained PromptsSection shape (own load/save, its own footer). */
export function CliSection() {
  const { data, isLoading } = useMyCliSettings();
  const models = useBrainModels();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  // The dropdown value pairs provider + model; '' = the server default. '::' never appears in ids.
  const [selection, setSelection] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data) {
      setSelection(data.model ? `${data.modelProvider ?? ''}::${data.model}` : '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setSeeded(true);
    }
  }, [data]);

  // Auto-persist shortly after any change (the daemon restarts a running brain with the new model).
  const persist = () => {
    const [provider, ...rest] = selection.split('::');
    save.mutate(
      { model: selection ? rest.join('::') : '', modelProvider: selection ? (provider ?? '') : '', autoCompact, autoCompactAt },
      { onError: () => toast(t.cli.saveError, 'error') },
    );
  };
  useAutoSave([selection, autoCompact, autoCompactAt], persist, { ready: seeded });

  if (isLoading || !data) return <LoadingState />;

  const options = models.data ?? [];
  // Group by provider label for the <optgroup> rendering.
  const groups = [...new Set(options.map((o) => o.providerLabel))];
  const selected = options.find((o) => `${o.provider}::${o.model}` === selection);


  return (
    <>
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="text-xs text-text-muted">{t.cli.intro}</p>

        <SettingCard title={t.cli.modelLabel} icon={Cpu} description={t.cli.modelHint}>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-elevated" aria-hidden>
              <ModelIcon name={selected?.model ?? data.serverDefault ?? ''} size={18} />
            </span>
            <select
              value={selection}
              onChange={(e) => setSelection(e.target.value)}
              aria-label={t.cli.modelLabel}
              className="h-9 w-full rounded-md border border-border bg-bg px-3 font-mono text-sm text-text focus:border-accent"
            >
              <option value="">{t.cli.serverDefaultOption.replace('{model}', data.serverDefault ?? '')}</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {options.filter((o) => o.providerLabel === g).map((o) => (
                    <option key={`${o.provider}::${o.model}`} value={`${o.provider}::${o.model}`}>{o.model}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
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

    </>
  );
}
