'use client';
import { useCallback, useMemo, useState, useEffect } from 'react';
import { Bolt, Boxes, Brain, Eye, FolderGit2, Gauge, MoonStar, Server, Shrink, SlidersHorizontal, Zap } from 'lucide-react';
import { BrainModelField } from '../../components/ui/BrainModelField';
import { CompactThresholdsDrawer } from './CompactThresholdsDrawer';
import { ProjectModelsDrawer } from './ProjectModelsDrawer';
import { Badge } from '../../components/ui/Badge';
import { Button, buttonClassName } from '../../components/ui/Button';
import { Segmented } from '../../components/ui/Segmented';
import { SpatialGroup, SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { ReasoningScale } from '../../components/ui/ReasoningScale';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { apiErrorMessage } from '../../lib/elowenClient';
import { interpolate, useTranslation } from '../../lib/i18n';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback, type SaveFeedback } from '../../lib/saveFeedback';
import { useMe, useMyCliSettings, useMyPermissions, useBrainModels } from '../../lib/queries';
import { useSaveMyCliSettings, useSaveMyPermissions } from '../../lib/mutations';
import { isOfferedModel, roleKey, splitRoleKey } from '../../lib/modelRoles';
import { PermissionRulesCard } from './PermissionRulesCard';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';

const NO_REASONING_LEVELS: string[] = [];
const NO_PROJECT_PINS: Record<string, { provider: string; model: string }> = {};

/** Account → Models: every personal answer to "which model does what", followed by the runtime switches
 *  that shape a conversation without choosing a model.
 *
 *  **Model roles** — the primary model every new conversation starts on, the thinking level that applies
 *  to it, the vision fallback, the compaction model and the per-project pins — plus a cross-link to the
 *  instance roles for an administrator. Each inheritable row names the model it ACTUALLY resolves to in
 *  its own trigger, so nothing has to be opened to learn what runs.
 *
 *  **Chat runtime** — auto-compact and its per-model thresholds, Fast, YOLO, unattended asks and the
 *  permission rules. Same rows and same behaviour as before; only the heading above them is new.
 *
 *  Communication style lives in Personality. Its own load/save + autosave, per writer. */
export function CliSection({ onSaveState }: { onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { data, isLoading, isError, refetch } = useMyCliSettings();
  const models = useBrainModels();
  const me = useMe();
  const save = useSaveMyCliSettings();
  // The primary model patches ALONE (see its autosave below), so it gets its own mutation handle rather
  // than sharing the batched one and inheriting its pending state.
  const savePrimary = useSaveMyCliSettings();
  const saveProjects = useSaveMyCliSettings();
  const { toast } = useToast();
  const { t } = useTranslation();

  // The picker value pairs provider + model; '' = inherit. '::' never appears in ids, and a model id may
  // itself contain slashes — which is why the pair is not joined with one.
  const [primarySelection, setPrimarySelection] = useState('');
  const [visionSelection, setVisionSelection] = useState('');
  const [compactSelection, setCompactSelection] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [rulesFeedback, setRulesFeedback] = useState<SaveFeedback>({ status: 'idle' });
  const reportRulesState = useCallback((status: SaveStatus, retry?: () => void | Promise<void>) => {
    setRulesFeedback({ status, retry });
  }, []);
  const [autoCompact, setAutoCompact] = useState(false);
  const [autoCompactAt, setAutoCompactAt] = useState(80);
  const [fastMode, setFastMode] = useState(false);
  // Per-model threshold overrides (key `provider/model` → percent). Empty = every model uses the global.
  const [compactByModel, setCompactByModel] = useState<Record<string, number>>({});
  // Per-project pins (canonical Git root → provider/model). Written implicitly by the chat picker; this
  // section is the only place they can be seen and cleared.
  const [projectPins, setProjectPins] = useState<Record<string, { provider: string; model: string }>>(NO_PROJECT_PINS);
  const [thresholdsOpen, setThresholdsOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);

  const [seeded, setSeeded] = useState(false);
  // Seed once, on first arrival. A sibling save (this section's own primary-model pick, or its batched
  // autosave) invalidates ['my-cli-settings'] → refetch; re-seeding from that refetch would clobber an
  // edit still inside the autosave debounce, so only seed while not yet seeded.
  useEffect(() => {
    if (data && !seeded) {
      setPrimarySelection(data.model ? `${data.modelProvider ?? ''}::${data.model}` : '');
      setProjectPins(data.projectModelPreferences ?? NO_PROJECT_PINS);
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
  //
  // Elowen AI chat models honour the user's personal allow-list even for an administrator viewing their
  // own Account; the catalog is already per-user-scoped server-side for non-admins, so this narrowing is
  // what covers the admin case. `isOfferableExec` on the daemon stays the single existence bound — this
  // can only ever hide a model, never offer one the route would refuse.
  const allowedExecs = me.data?.user.allowed_execs ?? [];
  const modelOptions = useMemo(
    () => (models.data ?? []).filter((m) => allowedExecs.length === 0 || allowedExecs.includes(m.exec)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the array identity changes on every /auth/me render
    [models.data, allowedExecs.join('\u0000')],
  );
  // The instance's own default — what an EMPTY personal primary resolves to. It comes from the DAEMON
  // (`serverDefaultRoute`), computed by the helper the spawn path itself calls, and NOT from this
  // catalog: for a member the catalog is already narrowed to `allowed_execs`, which need not contain the
  // instance default, while the runtime uses it regardless (`selectionAllowed` judges only COMPLETE
  // selections). Looking it up here is what left such an account showing "Inherited" and nothing else.
  // The catalog flag is kept as the fallback for a daemon too old to send the route.
  const instanceDefault = data?.serverDefaultRoute
    ?? (() => { const flagged = modelOptions.find((m) => m.default); return flagged ? { provider: flagged.provider, providerLabel: flagged.providerLabel, model: flagged.model } : undefined; })();
  // The model this account's next conversation actually starts on: the local pick while one is in flight,
  // otherwise the persisted one, otherwise the instance default.
  const primaryKey = primarySelection || (data?.model ? `${data.modelProvider ?? ''}::${data.model}` : '');
  // An OFFERED explicit pick, or undefined when the pick is stale/refused — which is also what the
  // runtime does with it, so the two agree.
  const primaryPick = primaryKey ? modelOptions.find((m) => roleKey(m.provider, m.model) === primaryKey) : undefined;
  const activeModel = data && !primaryKey ? (modelOptions.find((m) => m.default) ?? modelOptions[0]) : primaryPick;
  // What the row must NAME as the effective primary: the honoured pick, else the instance default. A
  // stale pick contributes nothing, because the runtime skips it and starts on the default instead.
  const effectivePrimaryName = primaryPick?.model ?? instanceDefault?.model ?? '';
  const primaryUnavailable = !!primaryKey && !primaryPick;
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
  // The primary model patches ALONE — the cli-settings PATCH merges, so the batched fields above stay
  // untouched — and immediately, so rapid picks stay serialized. The daemon canonicalizes the pair, so
  // the response is what the local state adopts.
  const { status: primaryStatus, retry: retryPrimary } = useAutoSaveStatus([primarySelection], async () => {
    const at = primarySelection.indexOf('::');
    const provider = at > -1 ? primarySelection.slice(0, at) : '';
    const model = at > -1 ? primarySelection.slice(at + 2) : '';
    try {
      const saved = await savePrimary.mutateAsync({ model: primarySelection ? model : '', modelProvider: primarySelection ? provider : '' });
      const canonical = saved.model ? `${saved.modelProvider ?? ''}::${saved.model}` : '';
      if (canonical !== primarySelection) setPrimarySelection(canonical);
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      throw error;
    }
  }, { ready: seeded, delay: 0 });
  // Clearing a pin is its own write for the same reason: the map REPLACES the stored one, so it must not
  // ride along with a batch whose draft could be a beat behind.
  const { status: projectsStatus, retry: retryProjects } = useAutoSaveStatus([JSON.stringify(projectPins)], async () => {
    try {
      await saveProjects.mutateAsync({ projectModelPreferences: projectPins });
    } catch (error) {
      toast(apiErrorMessage(error), 'error');
      throw error;
    }
  }, { ready: seeded, delay: 0 });

  const feedback = combineSaveFeedback(
    { status: primaryStatus, retry: retryPrimary },
    { status: settingsStatus, retry: retrySettings },
    { status: projectsStatus, retry: retryProjects },
    { status: fastStatus, retry: retryFast },
    { status: yoloStatus, retry: retryYolo },
    { status: unattendedStatus, retry: retryUnattended },
    rulesFeedback,
  );
  useEffect(() => {
    onSaveState?.('cli', feedback.status, feedback.retry);
  }, [feedback.retry, feedback.status, onSaveState]);

  if (isError) return <ErrorState message={t.common.daemonUnreachable} onRetry={() => refetch()} />;
  if (isLoading || !data) return <LoadingState />;

  const inheritedBadge = <Badge>{t.settings.modelRoles.inherited}</Badge>;
  const unavailableBadge = <Badge tone="warning">{t.cli.unavailableBadge}</Badge>;
  const inheritLabel = (model: string | undefined) =>
    (model ? interpolate(t.settings.modelRoles.inherit, { model }) : t.cli.inheritUnknown);
  /** What a stored pick the catalog no longer offers must say: the id it holds, that it is not usable,
   *  and the model that therefore runs instead. Silence here is the lie — the runtime has already moved
   *  on and the row would otherwise present the dead pick as the active model. */
  const unavailableLabel = (stored: string, fallback: string) => interpolate(t.cli.unavailableSummary, {
    model: splitRoleKey(stored).model || stored,
    fallback: fallback || t.cli.unavailableNoFallback,
  });

  // VISION, three honest states. The catalog's verdict is TRI-STATE: `false` is a catalogued text-only
  // model, ABSENT means the catalog has no row — so the picker filters on `!== false` (fail-open) rather
  // than hiding everything it cannot vouch for, and inherit is only offered as "already covered" when the
  // primary explicitly reports `true`.
  const visionModels = modelOptions.filter((m) => m.vision !== false);
  const primaryReadsImages = activeModel?.vision === true;
  const visionPick = visionSelection ? visionModels.find((m) => roleKey(m.provider, m.model) === visionSelection) : undefined;
  const visionUnavailable = !!visionSelection && !visionPick;
  const visionDefaultLabel = primaryReadsImages
    ? interpolate(t.cli.visionInherit, { model: activeModel!.model })
    : t.cli.visionNoFallback;
  const visionStatus = visionUnavailable
    ? unavailableBadge
    : visionSelection
      ? undefined
      : primaryReadsImages ? inheritedBadge : <Badge tone="warning">{t.cli.visionNoFallbackBadge}</Badge>;

  // COMPACTION falls back to the effective primary when its pick is stale (`resolveCompactionFallback`
  // discards one it cannot resolve), so that is the model the unavailable summary must name.
  const compactPick = compactSelection ? modelOptions.find((m) => roleKey(m.provider, m.model) === compactSelection) : undefined;
  const compactUnavailable = !!compactSelection && !compactPick;

  const projectRoots = Object.keys(projectPins);
  const clearProjectPin = (root: string) => setProjectPins((current) => {
    const next = { ...current };
    delete next[root];
    return next;
  });

  return (
    <div className="flex flex-col gap-4">
      {/* A role table reads top-down: one column, in the order the questions are asked. */}
      <SpatialGroup title={t.settings.modelRoles.title} description={t.cli.modelRolesHint} icon={Boxes}>
      <SpatialRow
        title={t.cli.primaryModelLabel}
        icon={Brain}
        description={t.help.cliPrimaryModel}
        status={primaryUnavailable ? unavailableBadge : primarySelection ? undefined : inheritedBadge}
        control={(
          <BrainModelField
            value={primarySelection}
            onChange={setPrimarySelection}
            models={modelOptions}
            title={t.cli.primaryModelLabel}
            subtitle={t.help.cliPrimaryModel}
            defaultLabel={inheritLabel(instanceDefault?.model)}
            missingLabel={unavailableLabel(primarySelection, instanceDefault?.model ?? '')}
            keyOf={(m) => `${m.provider}::${m.model}`}
            manageAriaLabel={`${t.managePicker.manage}: ${t.cli.primaryModelLabel}`}
          />
        )}
      />

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
        status={visionStatus}
        control={(
          <BrainModelField
            value={visionSelection}
            onChange={setVisionSelection}
            models={visionModels}
            title={t.cli.visionModelLabel}
            subtitle={t.help.cliVisionModel}
            defaultLabel={visionDefaultLabel}
            missingLabel={unavailableLabel(visionSelection, primaryReadsImages ? effectivePrimaryName : '')}
            keyOf={(m) => `${m.provider}::${m.model}`}
            manageAriaLabel={`${t.managePicker.manage}: ${t.cli.visionModelLabel}`}
          />
        )}
      />

      <SpatialRow
        title={t.cli.compactModelLabel}
        icon={Shrink}
        description={t.help.cliCompactModel}
        status={compactUnavailable ? unavailableBadge : compactSelection ? undefined : inheritedBadge}
        control={(
          <BrainModelField
            value={compactSelection}
            onChange={setCompactSelection}
            models={modelOptions}
            title={t.cli.compactModelLabel}
            subtitle={t.help.cliCompactModel}
            defaultLabel={inheritLabel(effectivePrimaryName)}
            missingLabel={unavailableLabel(compactSelection, effectivePrimaryName)}
            keyOf={(m) => `${m.provider}::${m.model}`}
            manageAriaLabel={`${t.managePicker.manage}: ${t.cli.compactModelLabel}`}
          />
        )}
      />

      {/* Read-only summary: repointing a project is what the chat picker already does at the point of
          use, so a second writer here would be two hands on the same field. Clearing is the one action. */}
      <SpatialRow
        title={t.cli.projectModelsTitle}
        icon={FolderGit2}
        description={t.help.cliProjectModels}
        status={projectRoots.length > 0
          ? <span className="tabular-nums">{interpolate(t.cli.projectModelsCount, { n: String(projectRoots.length) })}</span>
          : <span className="text-muted-foreground">{t.cli.projectModelsNone}</span>}
        control={(
          <Button variant="outline" size="sm" icon={FolderGit2} onClick={() => setProjectsOpen(true)}>
            {t.managePicker.manage}
          </Button>
        )}
      />

      {/* Administrators only: a member cannot open /settings at all, so the row would be a door into a
          stop page. The instance roles are the other half of the same question for everyone who can. */}
      {me.data?.user.is_admin ? (
        <SpatialRow
          title={t.cli.instanceModelsTitle}
          icon={Server}
          description={t.help.cliInstanceModels}
          status={<span className="truncate font-mono">{instanceDefault?.model ?? '—'}</span>}
          actions={(
            <a href="/settings?cat=models" className={buttonClassName('ghost', 'sm')}>
              <Server size={14} aria-hidden />
              {t.cli.openSettings}
            </a>
          )}
        />
      ) : null}
      </SpatialGroup>

      <SpatialGroup title={t.cli.chatRuntimeTitle} description={t.cli.chatRuntimeHint} icon={SlidersHorizontal} columns={2}>
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
      <PermissionRulesCard onSaveState={reportRulesState} />
      </SpatialGroup>
      <ConfirmDialog
        open={confirmYolo}
        title={t.cli.yoloConfirmTitle}
        description={t.cli.yoloWarning}
        confirmLabel={t.cli.yoloConfirm}
        onConfirm={() => { setConfirmYolo(false); setYolo(true); }}
        onClose={() => setConfirmYolo(false)}
      />
      {projectsOpen ? (
        <ProjectModelsDrawer
          pins={projectPins}
          offered={(pin) => isOfferedModel(roleKey(pin.provider, pin.model), modelOptions)}
          fallback={effectivePrimaryName}
          onClear={clearProjectPin}
          onClose={() => setProjectsOpen(false)}
        />
      ) : null}
      {thresholdsOpen ? (
        <CompactThresholdsDrawer
          models={modelOptions}
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
