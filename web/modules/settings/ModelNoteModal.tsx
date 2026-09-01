'use client';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { useAutoSaveStatus } from '../../lib/useAutoSaveStatus';
import { useTranslation } from '../../lib/i18n';

/** Focused editor for a single model's model description (config.modelNotes[exec]). Kept separate
 *  from ModelModal so the description never rides the label/provider/preset-override save path — it is
 *  keyed purely by exec, so it applies uniformly to presets and custom models. Auto-saves on edit;
 *  `onSave` only persists (it must not close the modal). */
export function ModelNoteModal({ label, exec, initial, onClose, onSave }: {
  label: string;
  exec: string;
  initial: string;
  onClose: () => void;
  onSave: (note: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(initial);
  const { status, retry, flush } = useAutoSaveStatus([note], () => onSave(note.trim()));
  const closeDisabled = status === 'saving' || status === 'error';
  const close = async () => { const finalStatus = await flush(); if (finalStatus !== 'error') onClose(); };
  return (
    <Modal title={t.settings.modelNoteLabel} description={label} onClose={close} closeDisabled={closeDisabled} size="md" icon={FileText}>
      <ModalBody>
        <Field label={`${label} · ${exec}`} hint={t.help.modelNote}>
          <textarea
            aria-label={t.settings.modelNoteLabel}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.settings.modelNotePlaceholder}
            rows={4}
            autoFocus
            className="w-full resize-y rounded-lg border border-border bg-card p-2.5 text-sm text-foreground outline-none transition-colors focus:border-primary"
            style={{ transitionDuration: 'var(--motion-fast)' }}
          />
        </Field>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={retry} />}>
        <Button variant="accent" onClick={close} disabled={closeDisabled}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
