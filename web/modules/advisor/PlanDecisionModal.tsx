'use client';
import { ClipboardList, PlayCircle } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';

/** Plan mode's decision point, as a blocking modal — parity with the CLI's "Plan ready" picker. The model
 *  submitted a plan through `ExitPlanMode` and the turn settled: implementing it is the only thing that
 *  leaves plan mode, so the choice cannot be a line the reader scrolls past.
 *
 *  Dismissing (Cancel, Escape, the backdrop) stays in plan mode with the plan still in the transcript —
 *  refining needs no button, another message keeps the mode as it is. */
export function PlanDecisionModal({ plan, submitting, onImplement, onDismiss }: {
  plan: string;
  submitting: boolean;
  onImplement: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // The one advisor overlay that is NOT `inspect`. It is a decision the reader commits or cancels, and
  // the plan it presents has to be read in full before either — so on a phone it takes the screen rather
  // than sharing it with the transcript.
  return (
    <Modal title={t.brainChat.planDecisionTitle} onClose={onDismiss} size="md" icon={ClipboardList} description={t.brainChat.planDecision} intent="edit">
      <ModalBody gap={4}>
        <div data-testid="plan-decision-body" className="whitespace-pre-wrap break-words rounded-md border border-border bg-surface-muted px-3 py-2 text-sm leading-relaxed text-text">
          {plan}
        </div>
      </ModalBody>
      <ModalFooter>
        <Button data-testid="plan-decision-cancel" variant="ghost" onClick={onDismiss} disabled={submitting}>{t.common.cancel}</Button>
        <Button data-testid="plan-decision-implement" variant="accent" icon={PlayCircle} onClick={onImplement} disabled={submitting}>
          {t.brainChat.planImplement}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
