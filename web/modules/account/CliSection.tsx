'use client';
import { useState, useEffect } from 'react';
import { Eye, Gauge, MoonStar, Shrink, SlidersHorizontal, SlidersVertical, Zap } from 'lucide-react';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { CompactThresholdsDrawer } from './CompactThresholdsDrawer';
import { Segmented } from '../../components/ui/Segmented';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { Slider } from '../../components/ui/Slider';
import { ReasoningScale } from '../../components/ui/ReasoningScale';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { useMyCliSettings, useMyPermissions, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings, useSaveMyPermissions } from '../../lib/mutations';
import { PermissionRulesCard } from './PermissionRulesCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

const NO_REASONING_LEVELS: string[] = [];

/** Account → Elowen AI: per-user runtime settings for the embedded brain (web chat + `elowen chat`).
 *  Thinking level + vision fallback + auto-compact; the default model pickers render beside this
 *  section in AccountView. Communication style lives in Personality. Its own load/save + autosave. */
export function CliSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data, isLoading } = useMyCliSettings();
  const models = useBrainModels();
  const save = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  // The picker value pairs provider + model; '' = the server default. '::' never appears in ids.
  const [visionSelection, setVisionSelection] = useState('');
  const [compactSelection, setCompactSelection] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);
  // Per-model threshold overrides (key `provider/model` → percent). Empty = every model uses the global.
  const [compactByModel, setCompactByModel] = useState<Record<string, number>>({});
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);

  const [seeded, setSeeded] = useState(false);
  // Seed once, on first arrival. A sibling save (AccountView's Elowen-model pick, or this section's own
  // autosave) invalidates ['my-cli-settings'] → refetch; re-seeding from that refetch would clobber an
  // edit still inside the autosave debounce, so only seed while not yet seeded.
  useEffect(() => {
    if (data && !seeded) {
      setVisionSelection(data.visionModel ? `${data.visionModelProvider ?? ''}::${data.visionModel}` : '');
      setCompactSelection(data.compactModel ? `${data.compactModelProvider ?? ''}::${data.compactModel}` : '');
      setThinkingLevel(data.thinkingLevel ?? '');
      setAutoCompact(data.autoCompact);
      setAutoCompactAt(data.autoCompactAt);
      setCompactByModel(data.autoCompactAtByModel ?? {});
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
  // Permission defaults persist immediately. Failed values stay visible so the user can retry from
  // the section header instead of silently losing their intent.
  const { status: yoloStatus, retry: retryYolo } = useAutoSaveStatus([yolo], async () => {
    try {
      await savePermissions.mutateAsync({ yolo });
    } catch (error) {
      toast(t.cli.saveError, 'error');
      throw error;
    }
  }, { ready: yoloSeeded, delay: 0 });
  const { status: unattendedStatus, retry: retryUnattended } = useAutoSaveStatus([unattendedAsks], async () => {
    try {
      await savePermissions.mutateAsync({ unattendedAsks });
    } catch (error) {
      toast(t.cli.saveError, 'error');
      throw error;
    }
  }, { ready: yoloSeeded, delay: 0 });

  // Auto-persist shortly after any change. Sends only the fields this section owns — the PATCH merges,
  // so the Personality/default-model picks stay untouched.
  const { status: settingsStatus, retry: retrySettings } = useAutoSaveStatus([visionSelection, compactSelection, thinkingLevel, autoCompact, autoCompactAt, JSON.stringify(compactByModel)], async () => {
    const [vProvider, ...vRest] = visionSelection.split('::');
    const [cProvider, ...cRest] = compactSelection.split('::');
    try {
      await save.mutateAsync({
        visionModel: visionSelection ? vRest.join('::') : '', visionModelProvider: visionSelection ? (vProvider ?? '') : '',
        compactModel: compactSelection ? cRest.join('::') : '', compactModelProvider: compactSelection ? (cProvider ?? '') : '',
        thinkingLevel, autoCompact, autoCompactAt, autoCompactAtByModel: compactByModel,
      });
    } catch (error) {
      toast(t.cli.saveError, 'error');
      throw error;
    }
  }, { ready: seeded });

  const status = settingsStatus === 'error' || yoloStatus === 'error' || unattendedStatus === 'error'
    ? 'error'
    : settingsStatus === 'saving' || yoloStatus === 'saving' || unattendedStatus === 'saving'
      ? 'saving'
      : settingsStatus === 'saved' || yoloStatus === 'saved' || unattendedStatus === 'saved' ? 'saved' : 'idle';
  useEffect(() => {
    const retry = status === 'error'
      ? () => {
        if (settingsStatus === 'error') retrySettings();
        if (yoloStatus === 'error') retryYolo();
        if (unattendedStatus === 'error') retryUnattended();
      }
      : undefined;
    onSaveState?.('cli', status, retry);
  }, [onSaveState, retrySettings, retryUnattended, retryYolo, settingsStatus, status, unattendedStatus, yoloStatus]);

  if (isLoading || !data) return <LoadingState />;

  return (
    <div className="flex flex-col gap-4">
      <SpatialGroup>
      <SpatialRow title={t.cli.thinkingLabel} icon={Gauge} description={t.help.cliThinking}>
        <ReasoningScale
          ariaLabel={t.cli.thinkingLabel}
          value={thinkingLevel}
          onChange={setThinkingLevel}
          options={['', ...reasoningLevels].map((lv) => ({
            value: lv,
            label: lv === '' ? t.cli.thinkingDefault : (activeModel?.reasoningLabels?.[lv] ?? lv),
          }))}
        />
      </SpatialRow>

      <SpatialRow title={t.cli.visionModelLabel} icon={Eye} description={t.help.cliVisionModel}>
        <BrainModelField
          value={visionSelection}
          onChange={setVisionSelection}
          models={models.data ?? []}
          title={t.cli.visionModelLabel}
          subtitle={t.help.cliVisionModel}
          defaultLabel={t.cli.visionModelDefault}
          keyOf={(m) => `${m.provider}::${m.model}`}
          manageAriaLabel={`${t.managePicker.manage}: ${t.cli.visionModelLabel}`}
        />
      </SpatialRow>

      <SpatialRow title={t.cli.autoCompact} icon={SlidersHorizontal} description={t.help.cliAutoCompact}>
        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-3 text-sm text-text">
            <Toggle checked={autoCompact} onChange={setAutoCompact} label={t.cli.autoCompactToggle} />
            <span>{t.cli.autoCompactToggle}</span>
          </label>
          {autoCompact ? (
            <>
              <div className="flex items-center gap-4">
                <span className="shrink-0 text-xs text-text-muted">{t.cli.autoCompactAt}</span>
                <Slider value={autoCompactAt} min={30} max={95} step={5} onChange={setAutoCompactAt} aria-label={t.cli.autoCompactAt} />
                <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums text-text">{autoCompactAt}%</span>
              </div>
              <button
                type="button"
                onClick={() => setThresholdsOpen(true)}
                className="inline-flex w-fit items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-text"
              >
                <SlidersVertical size={13} aria-hidden />
                {t.cli.compactByModelManage}
                {Object.keys(compactByModel).length ? <span className="text-accent">({Object.keys(compactByModel).length})</span> : null}
              </button>
            </>
          ) : null}
        </div>
      </SpatialRow>

      <SpatialRow title={t.cli.compactModelLabel} icon={Shrink} description={t.help.cliCompactModel}>
        <BrainModelField
          value={compactSelection}
          onChange={setCompactSelection}
          models={models.data ?? []}
          title={t.cli.compactModelLabel}
          subtitle={t.help.cliCompactModel}
          defaultLabel={t.cli.compactModelDefault}
          keyOf={(m) => `${m.provider}::${m.model}`}
          manageAriaLabel={`${t.managePicker.manage}: ${t.cli.compactModelLabel}`}
        />
      </SpatialRow>

      <SpatialRow title={t.cli.yoloTitle} icon={Zap} description={t.cli.yoloWarning}>
        <label className="flex items-center gap-3 text-sm text-text">
          <Toggle checked={yolo} onChange={(next) => next ? setConfirmYolo(true) : setYolo(false)} label={t.cli.yoloToggle} />
          <span>{t.cli.yoloToggle}</span>
        </label>
      </SpatialRow>

      <SpatialRow title={t.cli.unattendedTitle} icon={MoonStar} description={t.help.cliUnattendedAsks}>
        <Segmented
          value={unattendedAsks}
          onChange={(v) => setUnattendedAsks(v === 'deny' ? 'deny' : 'allow')}
          options={[
            { value: 'allow', label: t.cli.unattendedAllow },
            { value: 'deny', label: t.cli.unattendedDeny },
          ]}
          aria-label={t.cli.unattendedTitle}
        />
      </SpatialRow>
      </SpatialGroup>

      <PermissionRulesCard />
      <ConfirmDialog
        open={confirmYolo}
        title={t.cli.yoloConfirmTitle}
        description={t.cli.yoloWarning}
        confirmLabel={t.cli.yoloConfirm}
        onConfirm={() => { setConfirmYolo(false); setYolo(true); }}
        onClose={() => setConfirmYolo(false)}
      />
      {thresholdsOpen ? (
        <CompactThresholdsDrawer
          models={models.data ?? []}
          thresholds={compactByModel}
          defaultPct={autoCompactAt}
          onChange={(key, pct) => setCompactByModel((prev) => {
            const next = { ...prev };
            if (pct == null) delete next[key];
            else next[key] = pct;
            return next;
          })}
          onClose={() => setThresholdsOpen(false)}
        />
      ) : null}
    </div>
  );
}
