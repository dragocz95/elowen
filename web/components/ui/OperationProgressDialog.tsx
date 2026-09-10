'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import type { EnvironmentOperation } from '../../../src/shared/wireContract';
import { useTranslation } from '../../lib/i18n';
import { Button } from './Button';
import { ModalBody, ModalFooter } from './Modal';
import { focusOverlaySurface, useOverlayIsolation } from './overlayStack';
import { Dialog, DialogContent, DialogHeader, DialogOverlay } from './shadcn/dialog';
import { Progress } from './shadcn/progress';

export interface OperationProgressDialogProps {
  open: boolean;
  /** What the person asked for, in their words. The dialog adds the step, never the intent. */
  title: string;
  operation: EnvironmentOperation | null;
  logTail?: string[];
  /** A transport failure of the read that follows the operation, distinct from a failed operation. */
  loadError?: string | null;
  /** Run the same intent again. Omitted, the retry action is not offered. */
  onRetry?: () => void;
  /** The stale-environment repair. Offered only while `recreatable` holds. */
  onRecreate?: () => void;
  recreatable?: boolean;
  /** `running` says whether the operation was still working when the dialog went away, which is what
   *  tells the caller to keep following it behind a status chip rather than forget it. */
  onClose: (info: { running: boolean }) => void;
  /** Fired once when a succeeded operation closes itself. */
  onSettled?: () => void;
  /** How long a success stays on screen before it closes itself. */
  successDelayMs?: number;
}

const RUNNING_STATUSES = new Set(['pending', 'running']);

/** One installer-style progress window, for every environment lifecycle operation there is.
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
  const titleId = useId();
  const logId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => setMounted(true), []);
  const { restoreFocus } = useOverlayIsolation({ enabled: mounted, rootRef: overlayRef });

  const status = operation?.status ?? 'pending';
  const running = RUNNING_STATUSES.has(status);
  const failed = status === 'failed';
  const succeeded = status === 'succeeded';
  const close = () => onClose({ running });

  // A success does not need acknowledging. It closes itself after a beat, so the common path costs no
  // click at all, and the caller is told once so it can settle whatever it was showing.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!succeeded || settledRef.current) return;
    settledRef.current = true;
    const timer = setTimeout(() => { onSettled?.(); onClose({ running: false }); }, successDelayMs);
    return () => clearTimeout(timer);
  }, [succeeded, successDelayMs, onSettled, onClose]);

  const percent = operation?.percent ?? null;
  const indeterminate = percent === null;
  const stepTotal = operation?.stepTotal ?? 0;
  const stepLabel = operation?.stepLabel ?? null;
  const stepText = stepLabel ? (s.steps[stepLabel as keyof typeof s.steps] ?? stepLabel) : null;
  const message = failed ? (operation?.error ?? loadError ?? s.failed)
    : succeeded ? s.succeeded
      : stepText ?? s.preparing;
  const counter = stepTotal > 0 && running
    ? s.stepOf.replace('{current}', String((operation?.stepIndex ?? 0) + 1)).replace('{total}', String(stepTotal))
    : null;

  if (!mounted) return null;
  return createPortal(
    <Dialog open onOpenChange={(next) => { if (!next) close(); }}>
      <DialogOverlay ref={overlayRef} presentation="center">
        <DialogContent
          ref={dialogRef}
          presentation="center"
          size="sm"
          aria-labelledby={titleId}
          aria-busy={running || undefined}
          data-elowen-modal
          data-testid="operation-progress-dialog"
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => { event.preventDefault(); if (dialogRef.current) focusOverlaySurface(dialogRef.current); }}
          onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}
        >
          <DialogHeader title={title} titleId={titleId} closeLabel={t.common.close} onClose={close} />
          <ModalBody gap={4}>
            <div className="flex items-center gap-2 text-sm text-foreground">
              {running ? <Loader2 size={14} className="shrink-0 animate-spin text-muted-foreground" aria-hidden /> : null}
              <span role={failed ? 'alert' : 'status'} className="min-w-0 break-words">{message}</span>
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
        </DialogContent>
      </DialogOverlay>
    </Dialog>,
    document.body,
  );
}
