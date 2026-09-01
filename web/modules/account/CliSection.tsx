'use client';
import { useState, useEffect } from 'react';
import { Bolt, Eye, Gauge, MoonStar, Shrink, SlidersHorizontal, Zap } from 'lucide-react';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { CompactThresholdsDrawer } from './CompactThresholdsDrawer';
import { Segmented } from '../../components/ui/Segmented';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { ReasoningScale } from '../../components/ui/ReasoningScale';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback } from '../../lib/saveFeedback';
import { useMyCliSettings, useMyPermissions, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings, useSaveMyPermissions } from '../../lib/mutations';
import { PermissionRulesCard } from './PermissionRulesCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

const NO_REASONING_LEVELS: string[] = [];

/** Account → Elowen AI: per-user runtime settings for the embedded brain (web chat + `elowen chat`).
 *  Thinking level + vision fallback + auto-compact; the default model pickers render beside this
 *  section in AccountView. Communication style lives in Personality. Its own load/save + autosave. */
export function CliSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data, isLoading, isError, refetch } = useMyCliSettings();
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
  const [fastMode, setFastMode] = useState(false);
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
      setFastMode(data.fastMode ?? false);
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
  const anyFastRoute = modelOptions.some((model) => model.fastAvailable === true);
  const activeFastSupported = activeModel?.fastAvailable === true;
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
  // Fast must patch alone: the daemon deliberately skips every session respawn for a fast-only save because
  // already-live conversations read this account value on their next provider request.
  const { status: fastStatus, retry: retryFast } = useAutoSaveStatus([fastMode], async () => {
    try {
      await save.mutateAsync({ fastMode });
    } catch (error) {
      toast(t.cli.saveError, 'error');
      throw error;
    }
  }, { ready: seeded, delay: 0 });

  const feedback = combineSaveFeedback(
    { status: settingsStatus, retry: retrySettings },
    { status: fastStatus, retry: retryFast },
    { status: yoloStatus, retry: retryYolo },
    { status: unattendedStatus, retry: retryUnattended },
  );
  useEffect(() => {
    onSaveState?.('cli', feedback.status, feedback.retry);
  }, [feedback.retry, feedback.status, onSaveState]);

  if (isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
  if (isLoading || !data) return <LoadingState />;

  return (
    <div className="flex flex-col gap-4">
      <SpatialGroup columns={2}>
      <SpatialRow
        title={t.cli.thinkingLabel}
        icon={Gauge}
        description={t.help.cliThinking}
        control={(
          <ReasoningScale
            ariaLabel={t.cli.thinkingLabel}
            value={thinkingLevel}
            onChange={setThinkingLevel}
            options={['', ...reasoningLevels].map((lv) => ({
              value: lv,
              label: lv === '' ? t.cli.thinkingDefault : (activeModel?.reasoningLabels?.[lv] ?? lv),
            }))}
          />
        )}
      />

      <SpatialRow
        title={t.cli.visionModelLabel}
        icon={Eye}
        description={t.help.cliVisionModel}
        control={(
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
        )}
      />

      {/* The percentage is the value this switch reads at, so it belongs in the record's status rather
          than crowding the control; the per-model overrides are the row's one action. */}
      <SpatialRow
        title={t.cli.autoCompact}
        icon={SlidersHorizontal}
        description={t.help.cliAutoCompact}
        status={autoCompact ? <span className="font-mono tabular-nums text-foreground">{autoCompactAt}%</span> : undefined}
        control={<Toggle checked={autoCompact} onChange={setAutoCompact} label={t.cli.autoCompactToggle} />}
        actions={(
          <button type="button" className="spatial-inline-action" onClick={() => setThresholdsOpen(true)}>
            <SlidersHorizontal size={14} aria-hidden />{t.cli.compactByModelTitle}
          </button>
        )}
      />

      <SpatialRow
        title={t.cli.compactModelLabel}
        icon={Shrink}
        description={t.help.cliCompactModel}
        control={(
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
        )}
      />

      {/* The switch's own label named the row a second time; only the caveat is worth a trailing word,
          and a caveat about the CURRENT model is exactly what a status is for. */}
      <SpatialRow
        title={t.cli.fastModeTitle}
        icon={Bolt}
        description={t.help.cliFastMode}
        status={!anyFastRoute
          ? t.cli.fastModeUnavailable
          : fastMode && !activeFastSupported ? t.cli.fastModeCurrentUnsupported : undefined}
        control={<Toggle checked={fastMode} onChange={setFastMode} disabled={!anyFastRoute} label={t.cli.fastModeToggle} />}
      />

      {/* The warning lives behind the row's help affordance like every other explanation on this surface. */}
      <SpatialRow
        title={t.cli.yoloTitle}
        icon={Zap}
        description={t.cli.yoloWarning}
        control={<Toggle checked={yolo} onChange={(next) => next ? setConfirmYolo(true) : setYolo(false)} label={t.cli.yoloToggle} />}
      />

      <SpatialRow
        title={t.cli.unattendedTitle}
        icon={MoonStar}
        description={t.help.cliUnattendedAsks}
        control={(
          <Segmented
            value={unattendedAsks}
            onChange={(v) => setUnattendedAsks(v === 'deny' ? 'deny' : 'allow')}
            options={[
              { value: 'allow', label: t.cli.unattendedAllow },
              { value: 'deny', label: t.cli.unattendedDeny },
            ]}
            aria-label={t.cli.unattendedTitle}
          />
        )}
      />
      {/* Permission rules are one more record of this card; the rule editor itself opens in a drawer. */}
      <PermissionRulesCard />
      </SpatialGroup>
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
          onDefaultChange={setAutoCompactAt}
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
