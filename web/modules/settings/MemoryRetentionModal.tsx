'use client';
import { ShieldCheck, Clock, Gauge, Timer, Pin, type LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { HelpTip } from '../../components/ui/HelpTip';
import { Slider } from '../../components/ui/Slider';
import { Toggle } from '../../components/ui/Toggle';
import { useTranslation } from '../../lib/i18n';
import { plural } from '../../lib/i18n/plural';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import type { MemoryRetentionConfig, RuntimeConfig } from '../../lib/types';

/** Fallback for seeding the retention block before the daemon's config arrives — mirrors the daemon's
 *  `DEFAULT_MEMORY_RETENTION` (src/brain/memoryVitality.ts), kept in step by memoryRetentionParity.test. */
export const DEFAULT_MEMORY_RETENTION: MemoryRetentionConfig = {
  enabled: true,
  graceDays: 14,
  vitalityFloor: 10,
  halfLifeByImportance: { 1: 3, 2: 7, 3: 14, 4: 30, 5: 0, },
};

/** Which importance levels get a half-life knob. 5 is deliberately absent: the daemon never decays or
 *  evicts importance-5 memories, so a slider there would be a knob with no effect. */
const HALF_LIFE_LEVELS = [1, 2, 3, 4] as const;

/** Display row for the two scalar knobs. Every min/max MIRRORS the daemon's clamp bound in
 *  `src/store/configStore.ts` (`RETENTION_BOUNDS`), so a slider can never offer a value the daemon would
 *  silently lower — `web/tests/modules/settings/memoryRetentionParity.test.ts` fails on drift. */
const RETENTION_FIELDS: { key: 'graceDays' | 'vitalityFloor'; min: number; max: number; icon: LucideIcon }[] = [
  { key: 'graceDays', min: 0, max: 365, icon: Clock },
  { key: 'vitalityFloor', min: 0, max: 90, icon: Gauge },
];
/** Shared range for every half-life slider; 0 is the "never" sentinel, matching the daemon's bound. */
const HALF_LIFE_RANGE: readonly [number, number] = [0, 90];

/** Modal editor for memory auto-retention (the `runtime.memoryRetention` block, sibling of the Runtime
 *  limits editor). Edits flow straight back into the caller's state, which auto-saves through the shared
 *  status controller, so there is no Save button. */
export function MemoryRetentionModal({ runtime, applied, onChange, onClose, status = 'idle', retry, flush, presentation }: {
  runtime: RuntimeConfig;
  /** Fields the daemon clamped on the last save, each carrying the value actually in force — otherwise a
   *  refused value would look to the operator like it had taken effect. */
  applied?: Partial<MemoryRetentionConfig>;
  onChange: (next: (cur: RuntimeConfig) => RuntimeConfig) => void;
  onClose: () => void;
  status?: SaveStatus;
  retry?: () => void | Promise<void>;
  flush?: () => Promise<SaveStatus>;
  presentation?: 'center' | 'drawer';
}) {
  const { t } = useTranslation();
  const closeDisabled = status === 'saving' || status === 'error';
  const close = async () => {
    const finalStatus = await flush?.();
    if (finalStatus !== 'error') onClose();
  };
  const retention = runtime.memoryRetention ?? DEFAULT_MEMORY_RETENTION;

  const patch = (next: Partial<MemoryRetentionConfig>) =>
    onChange((cur) => ({ ...cur, memoryRetention: { ...(cur.memoryRetention ?? DEFAULT_MEMORY_RETENTION), ...next } }));
  const setHalfLife = (level: number, days: number) =>
    onChange((cur) => {
      const base = cur.memoryRetention ?? DEFAULT_MEMORY_RETENTION;
      return { ...cur, memoryRetention: { ...base, halfLifeByImportance: { ...base.halfLifeByImportance, [level]: days } } };
    });

  const daysLabel = (value: number): string => `${value} ${plural(t.brain.runtime.dayUnit, value)}`;
  const halfLifeLabel = (value: number): string => (value === 0 ? t.brain.retention.never : daysLabel(value));

  return (
    <Modal title={t.brain.retention.title} description={t.brain.retention.hint} icon={ShieldCheck} size="md" onClose={close} closeDisabled={closeDisabled} presentation={presentation}>
      <ModalBody>
        <div className="flex flex-col divide-y divide-border">
          <div className="flex items-center gap-2.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
              <ShieldCheck size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
              {t.brain.retention.enabled}
              <HelpTip>{t.brain.retention.enabledHint}</HelpTip>
            </span>
            <Toggle
              checked={retention.enabled}
              onChange={(next) => patch({ enabled: next })}
              label={t.brain.retention.enabled}
            />
          </div>

          {RETENTION_FIELDS.map((field) => {
            const Icon = field.icon;
            const value = retention[field.key];
            const valueLabel = field.key === 'graceDays' ? daysLabel(value) : String(value);
            const clamped = applied?.[field.key];
            return (
              <div key={field.key} className="py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
                    {t.brain.retention[field.key]}
                    <HelpTip>{t.brain.retention[`${field.key}Hint`]}</HelpTip>
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-primary">{valueLabel}</span>
                </div>
                <Slider
                  value={value}
                  min={field.min}
                  max={field.max}
                  step={1}
                  onChange={(next) => patch({ [field.key]: next })}
                  aria-label={t.brain.retention[field.key]}
                  aria-valuetext={valueLabel}
                  className="mt-3"
                />
                {clamped !== undefined ? (
                  <p className="mt-2 text-tiny leading-relaxed text-muted-foreground">
                    {t.brain.runtime.clamped.replace('{value}', field.key === 'graceDays' ? daysLabel(clamped) : String(clamped))}
                  </p>
                ) : null}
              </div>
            );
          })}

          {HALF_LIFE_LEVELS.map((level) => {
            const value = retention.halfLifeByImportance[level] ?? 0;
            const valueLabel = halfLifeLabel(value);
            const clamped = applied?.halfLifeByImportance?.[level];
            return (
              <div key={level} className="py-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                    <Timer size={18} aria-hidden />
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
                    {t.brain.retention.halfLifeLevel.replace('{n}', String(level))}
                    {level === 1 ? <HelpTip>{t.brain.retention.halfLifeHint}</HelpTip> : null}
                  </span>
                  <span className="shrink-0 font-mono text-sm tabular-nums text-primary">{valueLabel}</span>
                </div>
                <Slider
                  value={value}
                  min={HALF_LIFE_RANGE[0]}
                  max={HALF_LIFE_RANGE[1]}
                  step={0.1}
                  onChange={(next) => setHalfLife(level, next)}
                  aria-label={t.brain.retention.halfLifeLevel.replace('{n}', String(level))}
                  aria-valuetext={valueLabel}
                  className="mt-3"
                />
                {clamped !== undefined ? (
                  <p className="mt-2 text-tiny leading-relaxed text-muted-foreground">
                    {t.brain.runtime.clamped.replace('{value}', halfLifeLabel(clamped))}
                  </p>
                ) : null}
              </div>
            );
          })}

          {/* Importance 5 is pinned by the daemon (never decays, never evicted) — shown, not editable. */}
          <div className="flex items-center gap-2.5 py-3.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
              <Pin size={18} aria-hidden />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
              {t.brain.retention.pinned}
              <HelpTip>{t.brain.retention.pinnedHint}</HelpTip>
            </span>
            <span className="shrink-0 font-mono text-sm tabular-nums text-muted-foreground">{t.brain.retention.never}</span>
          </div>
        </div>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={retry} />}>
        <Button variant="accent" onClick={close} disabled={closeDisabled}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
