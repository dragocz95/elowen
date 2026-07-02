'use client';
import { useState, useEffect } from 'react';
import { Cpu, SlidersHorizontal, Save } from 'lucide-react';
import { SettingCard } from '../../components/ui/SettingCard';
import { Input } from '../../components/ui/Input';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { Button } from '../../components/ui/Button';
import { FormFooter } from '../../components/ui/FormFooter';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings } from '../../lib/queries';
import { useSaveMyCliSettings } from '../../lib/mutations';

/** Account → CLI: per-user settings for the Orca brain (`orca chat`). Model override + auto-compact,
 *  mirroring the self-contained PromptsSection shape (own load/save, its own footer). */
export function CliSection() {
  const { data, isLoading } = useMyCliSettings();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [model, setModel] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);

  useEffect(() => {
    if (data) { setModel(data.model); setAutoCompact(data.autoCompact); setAutoCompactAt(data.autoCompactAt); }
  }, [data]);

  if (isLoading || !data) return <LoadingState />;

  const onSave = () => save.mutate(
    { model: model.trim(), autoCompact, autoCompactAt },
    { onSuccess: () => toast(t.cli.saved), onError: () => toast(t.cli.saveError, 'error') },
  );

  return (
    <>
      <div className="flex max-w-2xl flex-col gap-4">
        <p className="text-xs text-text-muted">{t.cli.intro}</p>

        <SettingCard title={t.cli.modelLabel} icon={Cpu} description={t.cli.modelHint}>
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t.cli.modelPlaceholder} className="font-mono" />
          {data.serverDefault ? (
            <p className="mt-2 text-xs text-text-muted">{t.cli.serverDefault}: <span className="font-mono">{data.serverDefault}</span></p>
          ) : null}
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

      <FormFooter>
        <Button variant="accent" icon={Save} onClick={onSave} disabled={save.isPending}>{t.cli.save}</Button>
      </FormFooter>
    </>
  );
}
