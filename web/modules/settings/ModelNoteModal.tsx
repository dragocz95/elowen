'use client';
import { useState } from 'react';
import { FileText } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Field } from '../../components/ui/Field';
import { useTranslation } from '../../lib/i18n';

/** Focused editor for a single model's autopilot description (config.modelNotes[exec]). Kept separate
 *  from ModelModal so the description never rides the label/provider/preset-override save path — it is
 *  keyed purely by exec, so it applies uniformly to presets and custom models. */
export function ModelNoteModal({ label, exec, initial, onClose, onSave }: {
  label: string;
  exec: string;
  initial: string;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(initial);
  return (
    <Modal title={t.settings.modelNoteLabel} description={label} onClose={onClose} size="md" icon={FileText}>
      <ModalBody>
        <Field label={`${label} · ${exec}`} hint={t.help.modelNote}>
          <textarea
            aria-label={t.settings.modelNoteLabel}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.settings.modelNotePlaceholder}
            rows={4}
            autoFocus
            className="w-full resize-y rounded-lg border border-border bg-surface p-2.5 text-sm text-text outline-none transition-colors focus:border-accent"
            style={{ transitionDuration: 'var(--motion-fast)' }}
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.settings.cancel}</Button>
        <Button variant="accent" onClick={() => onSave(note.trim())}>{t.settings.save}</Button>
      </ModalFooter>
    </Modal>
  );
}
