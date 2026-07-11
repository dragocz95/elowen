'use client';
import { SlidersHorizontal, AlignLeft, Type, Timer, Brain, ListChecks, Target, Repeat, MessagesSquare, type LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { HelpTip } from '../../components/ui/HelpTip';
import { useTranslation } from '../../lib/i18n';
import type { BrainLimits } from '../../lib/types';

/** Fallback for seeding the Limits form before the daemon's config arrives (it always sends real values). */
export const BRAIN_LIMIT_DEFAULTS: BrainLimits = {
  toolOutputMaxLines: 80, toolOutputMaxChars: 12000, elicitationTimeoutMs: 300000,
  memoryRecallCount: 6, memoryRecallChars: 1500, goalTurnBudget: 8, goalMaxTurns: 64, channelSessionCap: 32,
};

/** The Limits inputs, in display order, each with its UI bounds (the daemon re-clamps to the same range)
 *  and a field icon. */
const BRAIN_LIMIT_FIELDS: { key: keyof BrainLimits; min: number; max: number; step: number; icon: LucideIcon }[] = [
  { key: 'toolOutputMaxLines', min: 20, max: 400, step: 10, icon: AlignLeft },
  { key: 'toolOutputMaxChars', min: 2000, max: 50000, step: 1000, icon: Type },
  { key: 'elicitationTimeoutMs', min: 30000, max: 1800000, step: 30000, icon: Timer },
  { key: 'memoryRecallCount', min: 1, max: 20, step: 1, icon: Brain },
  { key: 'memoryRecallChars', min: 300, max: 8000, step: 100, icon: ListChecks },
  { key: 'goalTurnBudget', min: 1, max: 50, step: 1, icon: Target },
  { key: 'goalMaxTurns', min: 8, max: 500, step: 1, icon: Repeat },
  { key: 'channelSessionCap', min: 4, max: 256, step: 1, icon: MessagesSquare },
];

/** Modal editor for the operator-tunable brain limits. Edits flow straight back into the caller's
 *  `limits` state (which auto-saves through the shared status controller), so there is no Save button — Done just closes.
 *  Clearing a field snaps it to the min so the local input matches what the daemon stores. */
export function BrainLimitsModal({ limits, onChange, onClose }: {
  limits: BrainLimits;
  onChange: (next: (cur: BrainLimits) => BrainLimits) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal title={t.brain.limits.title} description={t.brain.limits.hint} icon={SlidersHorizontal} size="md" onClose={onClose}>
      <ModalBody>
        <div className="@container">
          <div className="grid grid-cols-1 gap-4 @sm:grid-cols-2">
            {BRAIN_LIMIT_FIELDS.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.key} className="flex flex-col gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                    <Icon size={14} className="shrink-0 text-accent" aria-hidden />
                    {t.brain.limits[f.key]}
                    <HelpTip>{t.brain.limits[`${f.key}Hint`]}</HelpTip>
                  </span>
                  <Input
                    type="number" min={f.min} max={f.max} step={f.step}
                    value={String(limits[f.key])}
                    onChange={(e) => onChange((cur) => ({ ...cur, [f.key]: e.target.value === '' ? f.min : Number(e.target.value) }))}
                    aria-label={t.brain.limits[f.key]}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="accent" onClick={onClose}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
