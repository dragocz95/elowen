'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Cpu, Eye, Brain, SlidersHorizontal, MessageSquare, AtSign } from 'lucide-react';
import { ExecutorPicker } from '../../components/ui/ExecutorPicker';
import { SettingCard } from '../../components/ui/SettingCard';
import { Input } from '../../components/ui/Input';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
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
  const [visionSelection, setVisionSelection] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);
  const [advisorStyle, setAdvisorStyle] = useState('professional');
  const [discordUserId, setDiscordUserId] = useState('');

  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (data) {
      setSelection(data.model ? `${data.modelProvider ?? ''}::${data.model}` : '');
      setVisionSelection(data.visionModel ? `${data.visionModelProvider ?? ''}::${data.visionModel}` : '');
      setThinkingLevel(data.thinkingLevel ?? '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setAdvisorStyle(data.advisorStyle);
      setDiscordUserId(data.discordUserId ?? '');
      setSeeded(true);
    }
  }, [data]);

  // Auto-persist shortly after any change (the daemon restarts a running brain with the new model).
  const persist = () => {
    const [provider, ...rest] = selection.split('::');
    const [vProvider, ...vRest] = visionSelection.split('::');
    save.mutate(
      {
        model: selection ? rest.join('::') : '', modelProvider: selection ? (provider ?? '') : '',
        visionModel: visionSelection ? vRest.join('::') : '', visionModelProvider: visionSelection ? (vProvider ?? '') : '',
        thinkingLevel, autoCompact, autoCompactAt, advisorStyle, discordUserId,
      },
      { onError: () => toast(t.cli.saveError, 'error') },
    );
  };
  useAutoSave([selection, visionSelection, thinkingLevel, autoCompact, autoCompactAt, advisorStyle, discordUserId], persist, { ready: seeded });

  const thinkingOptions = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

  const styleOptions: { value: string; label: string; hint: string }[] = [
    { value: 'professional', label: t.cli.styleProfessional, hint: t.cli.styleProfessionalHint },
    { value: 'friendly', label: t.cli.styleFriendly, hint: t.cli.styleFriendlyHint },
    { value: 'concise', label: t.cli.styleConcise, hint: t.cli.styleConciseHint },
    { value: 'detailed', label: t.cli.styleDetailed, hint: t.cli.styleDetailedHint },
  ];

  if (isLoading || !data) return <LoadingState />;

  const options = models.data ?? [];
  // The picker speaks exec strings; this section stores provider::model — translate at the edges.
  const selectedExec = options.find((o) => `${o.provider}::${o.model}` === selection)?.exec ?? '';
  const selectedVisionExec = options.find((o) => `${o.provider}::${o.model}` === visionSelection)?.exec ?? '';

  return (
    <>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">{t.cli.intro}</p>

        <SettingCard title={t.cli.modelLabel} icon={Cpu} description={t.cli.modelHint}>
          {/* Same grouped Orca AI picker as everywhere else (provider tabs + OAuth badge). The server
              already scopes the catalog per-user, so what renders here is exactly what may run. */}
          <ExecutorPicker
            value={selectedExec}
            onChange={(exec) => {
              const o = options.find((x) => x.exec === exec);
              setSelection(o ? `${o.provider}::${o.model}` : '');
            }}
            models={[]}
            kind="brain"
            defaultLabel={t.cli.serverDefaultOption.replace('{model}', data.serverDefault ?? '')}
          />
        </SettingCard>

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

        <SettingCard title={t.cli.thinkingLabel} icon={Brain} description={t.cli.thinkingHint}>
          <div className="flex flex-wrap gap-1.5">
            {thinkingOptions.map((lv) => {
              const on = thinkingLevel === lv;
              return (
                <button
                  key={lv || 'default'}
                  type="button"
                  onClick={() => setThinkingLevel(lv)}
                  aria-pressed={on}
                  className={`inline-flex items-center rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
                  style={{ transitionDuration: 'var(--motion-fast)' }}
                >
                  {lv === '' ? t.cli.thinkingDefault : lv}
                </button>
              );
            })}
          </div>
        </SettingCard>

        <SettingCard title={t.cli.styleLabel} icon={MessageSquare} description={t.cli.styleHint}>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {styleOptions.map((o) => {
                const on = advisorStyle === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setAdvisorStyle(o.value)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${on ? 'border-accent/50 bg-accent/15 text-accent' : 'border-border bg-elevated text-text-muted hover:border-border-strong hover:text-text'}`}
                    style={{ transitionDuration: 'var(--motion-fast)' }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-text-muted">{styleOptions.find((o) => o.value === advisorStyle)?.hint}</p>
          </div>
        </SettingCard>

        <SettingCard title={t.cli.discordId} icon={AtSign} description={t.cli.discordIdHint}>
          <Input value={discordUserId} onChange={(e) => setDiscordUserId(e.target.value)} placeholder="123456789012345678" className="max-w-xs font-mono" aria-label={t.cli.discordId} />
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
