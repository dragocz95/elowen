import { useEffect, useState } from 'react';
import { BrainCircuit, SlidersHorizontal, Gauge, ShieldCheck, Boxes } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Slider } from '../../components/ui/Slider';
import { BrainLimitsModal, BRAIN_LIMIT_DEFAULTS } from './BrainLimitsModal';
import { RuntimeLimitsModal, RUNTIME_LIMIT_DEFAULTS } from './RuntimeLimitsModal';
import { ToolDeferralModal } from './ToolDeferralModal';
import { MemoryRetentionModal, DEFAULT_MEMORY_RETENTION } from './MemoryRetentionModal';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { useUpdateConfig } from '../../lib/mutations';
import { useAutoSaveStatus, type SaveStatus } from '../../lib/useAutoSaveStatus';
import { combineSaveFeedback } from '../../lib/saveFeedback';
import type { BrainLimits, ElowenConfig, RuntimeConfig, RuntimeLimits, MemoryRetentionConfig } from '../../lib/types';
import { SettingsGroup, SettingsRow } from '../../components/ui/SettingsSurface';

/** The importance levels the retention block carries a half-life for (mirrors the daemon's clamp keys). */
const RETENTION_IMPORTANCE_KEYS = [1, 2, 3, 4, 5] as const;

/** Settings → Brain: assistant identity, brain limits, runtime policy, and retention. */
export function BrainRuntimeSection({ config, onSaveState }: { config: ElowenConfig | undefined; onSaveState?: (section: string, status: SaveStatus, retry?: () => void) => void }) {
  const { toast } = useToast();
  const { t } = useTranslation();
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [toolLoadingOpen, setToolLoadingOpen] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  // The assistant's display identity ("Elowen" by default) — feeds the persona everywhere it speaks.
  const updateConfig = useUpdateConfig();
  const [agentName, setAgentName] = useState('');
  const [nameSeeded, setNameSeeded] = useState(false);
  useEffect(() => {
    if (config && !nameSeeded) { setAgentName(config.brain?.agentName ?? 'Elowen'); setNameSeeded(true); }
  }, [config, nameSeeded]);
  const { status: nameStatus, retry: retryName } = useAutoSaveStatus([agentName], async () => {
    try { await updateConfig.mutateAsync({ brain: { agentName: agentName.trim() } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: nameSeeded && !!agentName.trim() });

  // Max agent steps per run (the turn is aborted past this) — a validated 1..1000 integer. The slider
  // moves in coarse 100-steps; the daemon still accepts any 1..1000 value (API, older configs).
  const [maxSteps, setMaxSteps] = useState('');
  const [stepsSeeded, setStepsSeeded] = useState(false);
  useEffect(() => {
    if (config && !stepsSeeded) { setMaxSteps(String(config.brain?.maxSteps ?? 200)); setStepsSeeded(true); }
  }, [config, stepsSeeded]);
  const parsedSteps = Number(maxSteps);
  const { status: stepsStatus, retry: retrySteps } = useAutoSaveStatus([maxSteps], async () => {
    const n = Number(maxSteps);
    try { await updateConfig.mutateAsync({ brain: { maxSteps: Math.min(1000, Math.max(1, Math.floor(n))) } }); }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: stepsSeeded && Number.isFinite(parsedSteps) && parsedSteps >= 1 });

  // Operator-tunable brain limits (one draft record, autosaved whole). The daemon re-clamps every field,
  // so an out-of-range keystroke is corrected server-side; the inputs carry the same bounds for the UI.
  const [limits, setLimits] = useState<BrainLimits | null>(null);
  const [limitsSeeded, setLimitsSeeded] = useState(false);
  // Fields the daemon sent back lowered, i.e. clamped. The save response IS the effective config, so a
  // clamp is compared against exactly what was sent; the editor then says so per row instead of leaving
  // the operator believing a refused value took effect. A field that saves unchanged drops out again.
  const [appliedLimits, setAppliedLimits] = useState<Partial<BrainLimits>>({});
  useEffect(() => {
    if (config && !limitsSeeded) { setLimits(config.brain?.limits ?? BRAIN_LIMIT_DEFAULTS); setLimitsSeeded(true); }
  }, [config, limitsSeeded]);
  const { status: limitsStatus, retry: retryLimits, flush: flushLimits } = useAutoSaveStatus([limits], async () => {
    if (!limits) return;
    try {
      const saved = await updateConfig.mutateAsync({ brain: { limits } });
      const effective = saved.brain?.limits;
      const clamped: Partial<BrainLimits> = {};
      for (const key of Object.keys(limits) as (keyof BrainLimits)[]) {
        const value = effective?.[key];
        if (value !== undefined && value !== limits[key]) clamped[key] = value;
      }
      setAppliedLimits(clamped);
    }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: limitsSeeded && !!limits });

  // The runtime knobs (the sibling group of the limits above) follow the same draft → autosave → report
  // what the daemon actually applied cycle; only the numeric half can be clamped, so only it is compared.
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null);
  const [runtimeSeeded, setRuntimeSeeded] = useState(false);
  const [appliedRuntime, setAppliedRuntime] = useState<Partial<RuntimeLimits>>({});
  const [appliedRetention, setAppliedRetention] = useState<Partial<MemoryRetentionConfig>>({});
  useEffect(() => {
    if (config && !runtimeSeeded) {
      setRuntime({
        limits: config.runtime?.limits ?? RUNTIME_LIMIT_DEFAULTS,
        toolDeferralEnabled: config.runtime?.toolDeferralEnabled ?? true,
        toolDeferralOverrides: config.runtime?.toolDeferralOverrides ?? { sources: {}, tools: {} },
        hostedToolSearch: config.runtime?.hostedToolSearch ?? {},
        // A daemon predating the feature serves the runtime block without the retention group — seed the
        // defaults so the editor always has the full block to edit (mirrors `brain.limits ?? defaults`).
        memoryRetention: config.runtime?.memoryRetention ?? DEFAULT_MEMORY_RETENTION,
        // Same reasoning for the sub-agent runner: an older daemon omits both fields, and its behaviour
        // IS the off/auto pair, so seeding them keeps the editor honest about what that daemon is doing.
        subagentRunnerEnabled: config.runtime?.subagentRunnerEnabled ?? false,
        subagentRunnerPoolMax: config.runtime?.subagentRunnerPoolMax ?? null,
        // Same again: a daemon predating provider-side compaction omits the field, and its behaviour is
        // the off state, so seeding `false` describes it correctly.
        remoteCompactionEnabled: config.runtime?.remoteCompactionEnabled ?? false,
      });
      setRuntimeSeeded(true);
    }
  }, [config, runtimeSeeded]);
  const { status: runtimeStatus, retry: retryRuntime, flush: flushRuntime } = useAutoSaveStatus([runtime], async () => {
    if (!runtime) return;
    try {
      // Tool loading owns its own explicit save. Omitting only those fields prevents this debounced editor
      // from replaying a stale tool-loading draft while preserving the runtime and retention controls it owns.
      const { toolDeferralEnabled: _toolDeferralEnabled, toolDeferralOverrides: _toolDeferralOverrides, hostedToolSearch: _hostedToolSearch, ...runtimePatch } = runtime;
      const { toolDeferThreshold: _toolDeferThreshold, ...limits } = runtimePatch.limits;
      const saved = await updateConfig.mutateAsync({ runtime: { ...runtimePatch, limits } });
      const effective = saved.runtime?.limits;
      const clamped: Partial<RuntimeLimits> = {};
      for (const key of Object.keys(runtime.limits) as (keyof RuntimeLimits)[]) {
        const value = effective?.[key];
        if (value !== undefined && value !== runtime.limits[key]) clamped[key] = value;
      }
      setAppliedRuntime(clamped);
      // The retention group clamps the same way (the daemon's RETENTION_BOUNDS) — report what actually
      // took effect per field, including each half-life level.
      const effectiveRetention = saved.runtime?.memoryRetention;
      const sentRetention = runtime.memoryRetention;
      const clampedRetention: Partial<MemoryRetentionConfig> = {};
      if (effectiveRetention && sentRetention) {
        if (effectiveRetention.enabled !== sentRetention.enabled) clampedRetention.enabled = effectiveRetention.enabled;
        if (effectiveRetention.graceDays !== sentRetention.graceDays) clampedRetention.graceDays = effectiveRetention.graceDays;
        if (effectiveRetention.vitalityFloor !== sentRetention.vitalityFloor) clampedRetention.vitalityFloor = effectiveRetention.vitalityFloor;
        const clampedHalfLives: Record<number, number> = {};
        for (const level of RETENTION_IMPORTANCE_KEYS) {
          const got = effectiveRetention.halfLifeByImportance[level];
          if (got !== undefined && got !== sentRetention.halfLifeByImportance[level]) clampedHalfLives[level] = got;
        }
        if (Object.keys(clampedHalfLives).length > 0) clampedRetention.halfLifeByImportance = clampedHalfLives;
      }
      setAppliedRetention(clampedRetention);
    }
    catch (error) { toast(t.brain.saveError, 'error'); throw error; }
  }, { ready: runtimeSeeded && !!runtime });

  const feedback = combineSaveFeedback(
    { status: nameStatus, retry: retryName },
    { status: stepsStatus, retry: retrySteps },
    { status: limitsStatus, retry: retryLimits },
    { status: runtimeStatus, retry: retryRuntime },
  );
  useEffect(() => {
    onSaveState?.('brain', feedback.status, feedback.retry);
  }, [feedback.retry, feedback.status, onSaveState]);

  if (!config) return null;
  return (
    <>
      {/* Identity + step ceiling on one row: the assistant's name (everywhere it speaks) and the max
          agent steps per run (Discord shows "Step N / MAX"). */}
      <SettingsGroup icon={BrainCircuit} columns={2}>
        <SettingsRow
          label={t.brain.agentName}
          icon={BrainCircuit}
          control={<Input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Elowen" aria-label={t.brain.agentName} />}
        />
        <SettingsRow
          label={t.brain.maxSteps}
          description={t.brain.maxStepsHint}
          icon={Gauge}
          control={(
            <Slider
              min={1} max={1000} step={1}
              value={Math.min(1000, Math.max(1, Number.isFinite(parsedSteps) && parsedSteps > 0 ? parsedSteps : 200))}
              onChange={(n) => setMaxSteps(String(n))}
              aria-label={t.brain.maxSteps}
              className="w-40"
            />
          )}
          status={<span className="tabular-nums">{Number.isFinite(parsedSteps) && parsedSteps > 0 ? parsedSteps : 200}</span>}
        />
        {/* Each of these four records IS one action — it opens the editor that owns the group of knobs —
            so the button sits in the actions slot rather than posing as the record's control. */}
        {limits ? (
          <SettingsRow
            label={t.brain.limits.title}
            description={t.brain.limits.hint}
            icon={SlidersHorizontal}
            actions={<Button variant="ghost" size="sm" icon={SlidersHorizontal} onClick={() => setLimitsOpen(true)}>{t.brain.limits.manage}</Button>}
          />
        ) : null}
        {runtime ? (
          <SettingsRow
            label={t.brain.runtime.title}
            description={t.brain.runtime.hint}
            icon={Gauge}
            actions={<Button variant="ghost" size="sm" icon={Gauge} onClick={() => setRuntimeOpen(true)}>{t.brain.runtime.manage}</Button>}
          />
        ) : null}
        {runtime ? (
          <SettingsRow
            label={t.brain.toolLoading.title}
            description={t.brain.toolLoading.hint}
            icon={Boxes}
            actions={<Button variant="ghost" size="sm" icon={Boxes} onClick={() => setToolLoadingOpen(true)}>{t.brain.toolLoading.manage}</Button>}
          />
        ) : null}
        {runtime ? (
          <SettingsRow
            label={t.brain.retention.title}
            description={t.brain.retention.hint}
            icon={ShieldCheck}
            actions={<Button variant="ghost" size="sm" icon={ShieldCheck} onClick={() => setRetentionOpen(true)}>{t.brain.retention.manage}</Button>}
          />
        ) : null}
      </SettingsGroup>
      {limits && limitsOpen ? (
            <BrainLimitsModal
              limits={limits}
              applied={appliedLimits}
              onChange={(fn) => setLimits((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setLimitsOpen(false)}
              status={limitsStatus}
              retry={retryLimits}
              flush={flushLimits}
            />
      ) : null}
      {runtime && runtimeOpen ? (
            <RuntimeLimitsModal
              runtime={runtime}
              applied={appliedRuntime}
              onChange={(fn) => setRuntime((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setRuntimeOpen(false)}
              status={runtimeStatus}
              retry={retryRuntime}
              flush={flushRuntime}
            />
      ) : null}
      {runtime && toolLoadingOpen ? (
            <ToolDeferralModal
              runtime={runtime}
              onSave={(patch) => updateConfig.mutateAsync(patch)}
              onSaved={(next) => setRuntime((current) => current ? {
                ...current,
                toolDeferralEnabled: next.toolDeferralEnabled,
                toolDeferralOverrides: next.toolDeferralOverrides,
                limits: { ...current.limits, toolDeferThreshold: next.limits.toolDeferThreshold },
              } : current)}
              onClose={() => setToolLoadingOpen(false)}
            />
      ) : null}
      {runtime && retentionOpen ? (
            <MemoryRetentionModal
              runtime={runtime}
              applied={appliedRetention}
              onChange={(fn) => setRuntime((cur) => (cur ? fn(cur) : cur))}
              onClose={() => setRetentionOpen(false)}
              status={runtimeStatus}
              retry={retryRuntime}
              flush={flushRuntime}
            />
      ) : null}
    </>
  );
}
