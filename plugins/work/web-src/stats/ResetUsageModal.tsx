import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { runtime } from '../runtime';

const { Button, Input, Modal, ModalBody, ModalFooter } = runtime().components;
const { useResetUsage, useToast, useTranslation } = runtime().hooks;

/** Confirmation for resetting the usage stats. Requires the operator to type the sentinel word so it
 *  can't be triggered by a stray click. Only the stored snapshots are wiped — the agents' CLI session
 *  transcripts are never touched — so this is safe and reversible by simply letting tasks run again. */
export function ResetUsageModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const reset = useResetUsage();
  const [typed, setTyped] = useState('');

  const armed = typed.trim().toUpperCase() === t.stats.resetConfirmWord;

  const onConfirm = () => {
    reset.mutate(undefined, {
      onSuccess: () => { toast(t.stats.resetDone); onClose(); },
      onError: () => toast(t.stats.resetFailed, 'error'),
    });
  };

  return (
    <Modal title={t.stats.resetTitle} onClose={onClose} size="sm" icon={AlertTriangle}>
      <ModalBody>
        <p className="text-sm leading-relaxed text-text-muted">{t.stats.resetBody}</p>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-text-muted">{t.stats.resetConfirmHint.replace('{word}', t.stats.resetConfirmWord)}</label>
          {/* The shared control, not a hand-rolled copy of it: a second input styled by hand drifts —
              this one had its own background and its own focus colour, so the same modal answered a
              focus differently than every other field in the app. */}
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            className="font-mono"
          />
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="danger" onClick={onConfirm} disabled={!armed || reset.isPending}>{t.stats.resetConfirm}</Button>
      </ModalFooter>
    </Modal>
  );
}
