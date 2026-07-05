'use client';
import { useState } from 'react';
import { Gauge } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { Input } from '../../components/ui/Input';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { useTranslation } from '../../lib/i18n';

/** Focused editor for one Orca AI model's max context window override. The card shows a compact
 *  read-only preview; the number itself is edited here so the cards stay quiet. Auto-saves the number
 *  on edit (validation preserved: an invalid entry simply doesn't persist); "Use default" clears the
 *  override. `onSave` only persists (it must not close the modal). */
export function ContextWindowModal({ model, initial, effective, onClose, onSave }: {
  model: string;
  /** Current operator override, or null when the provider/default value is in effect. */
  initial: number | null;
  /** Effective window (override, else provider-reported, else default) — shown as the placeholder. */
  effective: number;
  onClose: () => void;
  onSave: (value: number | null) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial != null ? String(initial) : '');
  const n = Number(value);
  const valid = value.trim() === '' || (Number.isFinite(n) && n >= 1);
  // Auto-save on edit; the guard keeps an invalid value from persisting (validation preserved).
  const { status, retry, flush } = useAutoSaveStatus([value], () => { if (valid) return onSave(value.trim() ? Math.floor(n) : null); });
  const close = () => { flush(); onClose(); };
  return (
    <Modal title={t.brain.contextWindow} description={model} onClose={close} size="sm" icon={Gauge}>
      <ModalBody>
        <Field label={t.brain.contextWindow} hint={t.help.orcaContextWindow}>
          <Input
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={String(effective)}
            autoFocus
            className="font-mono"
            aria-label={`${t.brain.contextWindow}: ${model}`}
          />
        </Field>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={retry} />}>
        {/* "Use default" is a deliberate clear (an action), so it stays an explicit control — it just
            drives the same auto-save by emptying the field. */}
        <Button variant="ghost" disabled={!value.trim()} onClick={() => setValue('')}>{t.brain.contextWindowUseDefault}</Button>
        <Button variant="accent" onClick={close}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
