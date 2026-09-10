'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { OperationProgressDialogProps } from 'elowen-plugin-ui-kit';
import { useTranslation } from '../../lib/i18n';
import { Button } from './Button';
import { Modal, ModalBody, ModalFooter } from './Modal';
import { Progress } from './shadcn/progress';

// The published props are the contract, so they are declared once, in the kit the plugin bundles read —
// exactly as `ConfirmDialog` does it. A second declaration here would be free to drift from what the
// bundles type against, and the runtime surface assertion would hide the difference.
export type { OperationProgressDialogProps } from 'elowen-plugin-ui-kit';

const RUNNING_STATUSES = new Set(['pending', 'running']);

/** One installer-style progress window, for every environment lifecycle operation there is. It is
 *  `Modal` content: the overlay, the focus policy and the dismissal all stay with the one component that
 *  owns them, and only the geometry (`sm`, centered) is declared here.
 *
 *  It is a VIEW: it renders the durable operation row the daemon pushes and owns no lifecycle state of
 *  its own. The row already declares its step list, its position in it and a percent that is a real
 *  figure wherever the work reports one — so this component never estimates, and an operation with no
 *  measurable inside (an image pull whose layer counts mean nothing as a whole) shows an indeterminate
 *  bar instead of a number nobody can stand behind.
 *
 *  Escape is deliberately not a cancel. While the work runs, dismissing HIDES the window and the
 *  container work carries on, because a lifecycle operation is durable and outlives the tab that started
 *  it; the caller keeps the operation id and offers a way back in. Once it has settled there is nothing
 *  to protect and Escape simply closes. */
export function OperationProgressDialog(props: OperationProgressDialogProps) {
  if (!props.open) return null;
  return <OpenOperationProgressDialog {...props} />;
}

function OpenOperationProgressDialog({
  title,
  operation,
  logTail = [],
  loadError = null,
  onRetry,
  onRecreate,
  recreatable = false,
  onClose,
  onSettled,
  successDelayMs = 1400,
}: OperationProgressDialogProps) {
  const { t } = useTranslation();
  const s = t.operationProgress;
  const logId = useId();
  const [showLog, setShowLog] = useState(false);

  const status = operation?.status ?? 'pending';
  const running = RUNNING_STATUSES.has(status);
  const failed = status === 'failed';
  const succeeded = status === 'succeeded';
  const close = () => onClose({ running });

  // A success does not need acknowledging. It closes itself after a beat, so the common path costs no
  // click at all, and the caller is told once so it can settle whatever it was showing.
  //
  // The callbacks are read at fire time rather than watched. Every call site passes an inline arrow, so
  // holding them in the dependency list armed the timer against a render and disarmed it on the next
  // one: any parent re-render inside the window cancelled the close and the window then hung on `Done`.
  // For the same reason there is no "already fired" flag: the effect answers the OPERATION's state, its
  // cleanup owns the timer, and a setup re-run (Strict Mode's, or `Activity` reactivating the instance)
  // simply arms it again instead of leaving the window stranded open.
  const settle = useRef<() => void>(() => {});
  settle.current = () => { onSettled?.(); onClose({ running: false }); };
  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => settle.current(), successDelayMs);
    return () => clearTimeout(timer);
  }, [succeeded, successDelayMs]);

  const percent = operation?.percent ?? null;
  const indeterminate = percent === null;
  const stepTotal = operation?.stepTotal ?? 0;
  const stepLabel = operation?.stepLabel ?? null;
  const stepText = stepLabel ? (s.steps[stepLabel as keyof typeof s.steps] ?? stepLabel) : null;
  // A read that never arrived is the one thing the operation row cannot report for itself: with nothing
  // to render, "Preparing" would sit there for as long as the window stays open.
  const message = failed ? (operation?.error ?? loadError ?? s.failed)
    : succeeded ? s.succeeded
      : loadError ?? stepText ?? s.preparing;
  const problem = failed || (!succeeded && loadError !== null);
  const counter = stepTotal > 0 && running
    ? s.stepOf.replace('{current}', String((operation?.stepIndex ?? 0) + 1)).replace('{total}', String(stepTotal))
    : null;

  return (
    <Modal
      title={title}
      size="sm"
      presentation="center"
      aria-busy={running || undefined}
      data-testid="operation-progress-dialog"
      onClose={close}
    >
      <ModalBody gap={4}>
        <div className="flex items-center gap-2 text-sm text-foreground">
          {running ? <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" aria-hidden /> : null}
          <span role={problem ? 'alert' : 'status'} className="min-w-0 break-words">{message}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Progress
            aria-label={s.progressLabel}
            value={indeterminate ? null : percent}
            indicatorValue={indeterminate ? 100 : percent}
            indicatorClassName={indeterminate ? 'animate-pulse opacity-60' : failed ? 'bg-destructive' : undefined}
          />
          <div className="flex items-center justify-between text-tiny text-muted-foreground">
            <span>{counter ?? ''}</span>
            <span>{indeterminate ? s.indeterminate : `${Math.round(percent)} %`}</span>
          </div>
        </div>
        {logTail.length ? (
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              aria-expanded={showLog}
              aria-controls={logId}
              onClick={() => setShowLog((current) => !current)}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              {showLog ? s.hideLog : s.showLog}
            </button>
            {showLog ? (
              <pre
                id={logId}
                aria-label={s.logLabel}
                className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-tiny leading-relaxed text-muted-foreground"
              >{logTail.join('\n')}</pre>
            ) : null}
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter>
        {failed && recreatable && onRecreate ? <Button variant="ghost" onClick={onRecreate}>{s.recreate}</Button> : null}
        {failed && onRetry ? <Button onClick={onRetry}>{s.retry}</Button> : null}
        <Button variant="ghost" onClick={close}>{running ? s.hide : t.common.close}</Button>
      </ModalFooter>
    </Modal>
  );
}
