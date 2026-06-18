'use client';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTranslation } from '../../lib/i18n';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, onConfirm, onClose }: ConfirmDialogProps) {
  const { t } = useTranslation();
  if (!open) return null;
  return (
    <Modal title={title} onClose={onClose} size="sm">
      <div className="flex flex-col gap-6 p-5">
        {description ? <p className="text-sm leading-relaxed text-text-muted">{description}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={onConfirm}>{confirmLabel ?? t.common.delete}</Button>
        </div>
      </div>
    </Modal>
  );
}
