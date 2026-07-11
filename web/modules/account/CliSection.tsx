'use client';
import { useState, useEffect } from 'react';
import { useAutoSave } from '../../lib/useAutoSave';
import { Eye, Gauge, MoonStar, SlidersHorizontal, Zap } from 'lucide-react';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { Segmented } from '../../components/ui/Segmented';
import { SettingGroup, SettingRow } from '../../components/ui/SettingsPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { ReasoningScale } from '../../components/ui/ReasoningScale';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useMyCliSettings, useMyPermissions, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings, useSaveMyPermissions } from '../../lib/mutations';
import { PermissionRulesCard } from './PermissionRulesCard';

const NO_REASONING_LEVELS: string[] = [];

/** Account → Elowen AI: per-user runtime settings for the embedded brain (web chat + `elowen chat`).
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
  // Seed once, on first arrival. A sibling save (AccountView's Elowen-model pick, or this section's own
  // autosave) invalidates ['my-cli-settings'] → refetch; re-seeding from that refetch would clobber an
  // edit still inside the autosave debounce, so only seed while not yet seeded.
  useEffect(() => {
    if (data && !seeded) {
      setVisionSelection(data.visionModel ? `${data.visionModelProvider ?? ''}::${data.visionModel}` : '');
      setThinkingLevel(data.thinkingLevel ?? '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setSeeded(true);
    }
  }, [data, seeded]);

  // Reasoning effort belongs to the selected model, not to a global universal list. The daemon enriches
  // every model option from PI's provider descriptor, including provider-facing labels such as
  // OpenAI's `ultra` (canonical xhigh) and the distinct `max` supported by newer models.
  const modelOptions = models.data ?? [];
  const activeModel = data
      ? (data.model
        ? modelOptions.find((m) => m.provider === data.modelProvider && m.model === data.model)
        : (modelOptions.find((m) => m.default) ?? modelOptions[0]))
    : undefined;
  const reasoningLevels = activeModel?.reasoningLevels ?? NO_REASONING_LEVELS;
  useEffect(() => {
    // A sibling default-model change invalidates cli-settings. If the new model cannot accept the old
    // effort, clear the override instead of keeping a request-breaking hidden value in the account.
    if (seeded && activeModel && thinkingLevel && !reasoningLevels.includes(thinkingLevel)) setThinkingLevel('');
  }, [activeModel, reasoningLevels, seeded, thinkingLevel]);

  // YOLO default + unattended-ask mode live in the separate permissions blob (GET/PATCH
  // /auth/me/permissions) — their own query + seed + autosave so flipping them never touches (or
  // restarts through) cli-settings. Each control patches ONLY its own field.
  const permissions = useMyPermissions();
  const savePermissions = useSaveMyPermissions();
  const [yolo, setYolo] = useState(false);
  const [unattendedAsks, setUnattendedAsks] = useState<'allow' | 'deny'>('allow');
  const [yoloSeeded, setYoloSeeded] = useState(false);
  // Seed once — PermissionRulesCard, AccountView and this section's own autosave all write
  // ['my-permissions']; re-seeding from any of those refetches would clobber an in-progress flip still
  // inside the autosave debounce.
  useEffect(() => {
    if (permissions.data && !yoloSeeded) {
      setYolo(permissions.data.yolo);
      setUnattendedAsks(permissions.data.unattendedAsks);
      setYoloSeeded(true);
    }
  }, [permissions.data, yoloSeeded]);
  // On save error, revert the optimistic value to the server truth. The query cache is never
  // optimistically mutated, so permissions.data still holds the pre-edit value; without this the
  // toggle would stay stuck on a value the server rejected (the seed guard won't re-seed it).
  useAutoSave([yolo], () => {
    savePermissions.mutate({ yolo }, {
      onError: () => { toast(t.cli.saveError, 'error'); if (permissions.data) setYolo(permissions.data.yolo); },
    });
  }, { ready: yoloSeeded });
  useAutoSave([unattendedAsks], () => {
    savePermissions.mutate({ unattendedAsks }, {
      onError: () => { toast(t.cli.saveError, 'error'); if (permissions.data) setUnattendedAsks(permissions.data.unattendedAsks); },
    });
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

  return (
    <div className="flex flex-col gap-4">
      <SettingGroup>
      <SettingRow title={t.cli.thinkingLabel} icon={Gauge} description={t.help.cliThinking}>
        <ReasoningScale
          ariaLabel={t.cli.thinkingLabel}
          value={thinkingLevel}
          onChange={setThinkingLevel}
          options={['', ...reasoningLevels].map((lv) => ({
            value: lv,
            label: lv === '' ? t.cli.thinkingDefault : (activeModel?.reasoningLabels?.[lv] ?? lv),
          }))}
        />
      </SettingRow>

      <SettingRow title={t.cli.visionModelLabel} icon={Eye} description={t.help.cliVisionModel}>
        <BrainModelField
          value={visionSelection}
          onChange={setVisionSelection}
          models={models.data ?? []}
          title={t.cli.visionModelLabel}
          subtitle={t.help.cliVisionModel}
          defaultLabel={t.cli.visionModelDefault}
          keyOf={(m) => `${m.provider}::${m.model}`}
        />
      </SettingRow>

      <SettingRow title={t.cli.autoCompact} icon={SlidersHorizontal} description={t.help.cliAutoCompact}>
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
      </SettingRow>

      <SettingRow title={t.cli.yoloTitle} icon={Zap} description={t.cli.yoloWarning}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={yolo} onChange={setYolo} label={t.cli.yoloToggle} />
          <span>{t.cli.yoloToggle}</span>
        </label>
      </SettingRow>

      <SettingRow title={t.cli.unattendedTitle} icon={MoonStar} description={t.help.cliUnattendedAsks}>
        <Segmented
          value={unattendedAsks}
          onChange={(v) => setUnattendedAsks(v === 'deny' ? 'deny' : 'allow')}
          options={[
            { value: 'allow', label: t.cli.unattendedAllow },
            { value: 'deny', label: t.cli.unattendedDeny },
          ]}
          aria-label={t.cli.unattendedTitle}
        />
      </SettingRow>
      </SettingGroup>

      <PermissionRulesCard />
    </div>
  );
}
