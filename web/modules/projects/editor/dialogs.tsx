'use client';
import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Field } from '../../../components/ui/Field';
import { useTranslation } from '../../../lib/i18n';

/** A single-text-input dialog (new file/folder, rename, duplicate). Submits on Enter; the confirm
 *  button is disabled while empty or unchanged. */
export function PromptDialog({ title, label, initialValue, confirmLabel, icon, onConfirm, onCancel }: {
  title: string; label: string; initialValue: string; confirmLabel: string; icon?: LucideIcon;
  onConfirm: (value: string) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed !== initialValue.trim();
  const submit = () => { if (valid) onConfirm(trimmed); };
  return (
    <Modal title={title} onClose={onCancel} size="sm" icon={icon}>
      <ModalBody gap={4}>
        <Field label={label}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} className="font-mono text-xs" autoFocus />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>{t.common.cancel}</Button>
        <Button variant="accent" onClick={submit} disabled={!valid}>{confirmLabel}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** A yes/no confirmation dialog (delete). */
export function ConfirmDialog({ title, message, confirmLabel, danger, icon, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; danger?: boolean; icon?: LucideIcon;
  onConfirm: () => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal title={title} onClose={onCancel} size="sm" icon={icon}>
      <ModalBody gap={4}>
        <p className="text-sm text-text-muted">{message}</p>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>{t.common.cancel}</Button>
        <Button variant={danger ? 'danger' : 'accent'} onClick={onConfirm}>{confirmLabel}</Button>
      </ModalFooter>
    </Modal>
  );
}
