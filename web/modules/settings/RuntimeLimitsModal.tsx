'use client';
import { Gauge, TerminalSquare, Radar, History, EyeOff, Activity, AlarmClock, MessageSquare, Copy, CopyCheck, Star, HeartPulse, PenLine, Cpu, type LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import { plural } from '../../lib/i18n/plural';
import type { RuntimeConfig, RuntimeLimits } from '../../lib/types';

/** Fallback for seeding the Runtime form before the daemon's config arrives (it always sends real values). */
export const RUNTIME_LIMIT_DEFAULTS: RuntimeLimits = {
  localShellTimeoutMs: 30000, memorySemanticFloorPerMille: 200,
  memoryDuplicatePerMille: 930, memoryParaphrasePerMille: 700,
  memoryImportanceWeightPerMille: 100, memoryVitalityWeightPerMille: 100, memoryCuratorMaxOps: 2,
  toolDeferThreshold: 10, eventRetentionDays: 30, originIpRetentionDays: 30,
  streamSilenceLimitMs: 75000, streamReviveSilenceLimitMs: 45000, toastDurationMs: 4500,
};

const MILLISECONDS_PER_SECOND = 1_000;
/** The cosine thresholds travel as integer per mille so the daemon's whole-number clamp cannot round a
 *  threshold away to zero; the slider shows the cosine value the operator reasons about. */
const PER_MILLE = 1_000;
/** Score weights travel in the same per-mille unit but read as a percentage of the score. */
const PER_MILLE_PER_PERCENT = 10;

type RuntimeLimitKind = 'seconds' | 'cosine' | 'count' | 'days' | 'share';
type RuntimeLimitField = {
  key: keyof RuntimeLimits;
  kind: RuntimeLimitKind;
  min: number;
  max: number;
  step: number;
  icon: LucideIcon;
};

/** Runtime knobs in display order. Every min/max MIRRORS the daemon's clamp bound in
 *  `src/store/configStore.ts` (the web may not import it — see the `web-not-to-backend` rule), so a slider
 *  can never offer a value the daemon would silently lower.
 *  `web/tests/modules/settings/runtimeLimitsParity.test.ts` compares the two tables and fails on drift;
 *  `kind` owns the UI unit conversion. */
const RUNTIME_LIMIT_FIELDS: RuntimeLimitField[] = [
  { key: 'localShellTimeoutMs', kind: 'seconds', min: 10000, max: 300000, step: 5000, icon: TerminalSquare },
  { key: 'memorySemanticFloorPerMille', kind: 'cosine', min: 100, max: 800, step: 10, icon: Radar },
  // The memory group stays together and in the order a memory travels: which ones count as related, when
  // two are the same fact on write, when they are on recall, what else besides the question decides the
  // ranking, and how much may be written at all.
  { key: 'memoryDuplicatePerMille', kind: 'cosine', min: 500, max: 980, step: 10, icon: CopyCheck },
  { key: 'memoryParaphrasePerMille', kind: 'cosine', min: 500, max: 980, step: 10, icon: Copy },
  { key: 'memoryImportanceWeightPerMille', kind: 'share', min: 0, max: 300, step: 10, icon: Star },
  { key: 'memoryVitalityWeightPerMille', kind: 'share', min: 0, max: 300, step: 10, icon: HeartPulse },
  { key: 'memoryCuratorMaxOps', kind: 'count', min: 0, max: 6, step: 1, icon: PenLine },
  { key: 'eventRetentionDays', kind: 'days', min: 1, max: 365, step: 1, icon: History },
  // Next to the log retention because both answer "how long is this kept", but this one is the privacy
  // horizon: past it the recorded address is replaced by a placeholder and only the totals remain.
  { key: 'originIpRetentionDays', kind: 'days', min: 1, max: 365, step: 1, icon: EyeOff },
  // Adjacent on purpose: the two are one setting asked at two moments (a watched page, and a wake-up where
  // no timer could have run), and they share a floor — 35 s, above the daemon's 30 s heartbeat, because a
  // limit inside the beat interval would call a healthy but idle stream dead.
  { key: 'streamSilenceLimitMs', kind: 'seconds', min: 35000, max: 300000, step: 5000, icon: Activity },
  { key: 'streamReviveSilenceLimitMs', kind: 'seconds', min: 35000, max: 300000, step: 5000, icon: AlarmClock },
  { key: 'toastDurationMs', kind: 'seconds', min: 2000, max: 15000, step: 500, icon: MessageSquare },
];

const DISPLAY_DIVISORS: Record<RuntimeLimitKind, number> = {
  seconds: MILLISECONDS_PER_SECOND,
  cosine: PER_MILLE,
  count: 1,
  days: 1,
  share: PER_MILLE_PER_PERCENT,
};

function toCanonicalValue(field: RuntimeLimitField, displayValue: number): number {
  const canonical = Math.round(displayValue * DISPLAY_DIVISORS[field.kind]);
  return Math.min(field.max, Math.max(field.min, canonical));
}

/** Modal editor for the operator-tunable runtime knobs (the sibling of the brain Limits editor). Edits
 *  flow straight back into the caller's state, which auto-saves through the shared status controller, so
 *  there is no Save button. */
export function RuntimeLimitsModal({ runtime, applied, onChange, onClose, presentation }: {
  runtime: RuntimeConfig;
  /** Fields the daemon clamped on the last save, each carrying the value actually in force — otherwise a
   *  refused value would look to the operator like it had taken effect. */
  applied?: Partial<RuntimeLimits>;
  onChange: (next: (cur: RuntimeConfig) => RuntimeConfig) => void;
  onClose: () => void;
  presentation?: 'center' | 'drawer';
}) {
  const { t } = useTranslation();
  /** A canonical value in the row's own display unit. */
  const displayLabel = (field: RuntimeLimitField, canonical: number): string => {
    const value = canonical / DISPLAY_DIVISORS[field.kind];
    if (field.kind === 'seconds') return `${Number(value.toFixed(1))} ${t.brain.runtime.secondUnit}`;
    if (field.kind === 'cosine') return value.toFixed(2);
    if (field.kind === 'share') return `${value} %`;
    if (field.kind === 'days') return `${value} ${plural(t.brain.runtime.dayUnit, value)}`;
    return String(value);
  };
  return (
    <Modal title={t.brain.runtime.title} description={t.brain.runtime.hint} icon={Gauge} size="md" onClose={onClose} presentation={presentation}>
      <ModalBody>
        <div className="flex flex-col divide-y divide-border">
          {RUNTIME_LIMIT_FIELDS.map((field) => {
            const Icon = field.icon;
            const divisor = DISPLAY_DIVISORS[field.kind];
            const value = runtime.limits[field.key] / divisor;
            const valueLabel = displayLabel(field, runtime.limits[field.key]);
            const clamped = applied?.[field.key];
            return (
              <div key={field.key} className="py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
                    {t.brain.runtime[field.key]}
                    <HelpTip>{t.brain.runtime[`${field.key}Hint`]}</HelpTip>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-primary">{valueLabel}</span>
                </div>
                <Slider
                  value={value}
                  min={field.min / divisor}
                  max={field.max / divisor}
                  step={field.step / divisor}
                  onChange={(next) => onChange((cur) => ({ ...cur, limits: { ...cur.limits, [field.key]: toCanonicalValue(field, next) } }))}
                  aria-label={t.brain.runtime[field.key]}
                  aria-valuetext={valueLabel}
                  className="mt-3"
                />
                {clamped !== undefined ? (
                  <p className="mt-2 text-tiny leading-relaxed text-text-muted">
                    {t.brain.runtime.clamped.replace('{value}', displayLabel(field, clamped))}
                  </p>
                ) : null}
              </div>
            );
          })}
          {/* The daemon re-reads this per delegation, so flipping it takes effect on the next sub-agent
              without a restart — that live read is what makes it a usable rollback under load. */}
          <div className="flex items-center gap-2.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
              <Cpu size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
              {t.brain.runtime.subagentRunnerEnabled}
              <HelpTip>{t.brain.runtime.subagentRunnerEnabledHint}</HelpTip>
            </span>
            <Toggle
              checked={runtime.subagentRunnerEnabled}
              onChange={(next) => onChange((cur) => ({ ...cur, subagentRunnerEnabled: next }))}
              label={t.brain.runtime.subagentRunnerEnabled}
            />
          </div>
          {/* Read live on every compaction and every request, so switching it off does not merely stop new
              blobs — the stored ones stop being sent too, from the next request on. */}
          <div className="flex items-center gap-2.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-text-muted">
              <Cpu size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-text">
              {t.brain.runtime.remoteCompactionEnabled}
              <HelpTip>{t.brain.runtime.remoteCompactionEnabledHint}</HelpTip>
            </span>
            <Toggle
              checked={runtime.remoteCompactionEnabled}
              onChange={(next) => onChange((cur) => ({ ...cur, remoteCompactionEnabled: next }))}
              label={t.brain.runtime.remoteCompactionEnabled}
            />
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="accent" onClick={onClose}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
