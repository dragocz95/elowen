'use client';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { ModalBody, ModalFooter } from './Modal';
import { Button, type ButtonVariant } from './Button';
import { Spinner } from './states';
import { useTranslation } from '../../lib/i18n';
import { useOverlayIsolation } from './overlayStack';
import { AlertDialog, AlertDialogContent } from './shadcn/alert-dialog';
import { DialogHeader, DialogOverlay } from './shadcn/dialog';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Additive styling axis for non-destructive confirmations; destructive remains the default. */
  confirmVariant?: ButtonVariant;
  pendingLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  error?: ReactNode;
  /** Returning a promise enables the built-in pending lock; synchronous callbacks remain unchanged. */
  onConfirm: () => unknown;
  onConfirmError?: (error: unknown) => void;
  onClose: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

/** A confirmation, on the shadcn `AlertDialog` and therefore on Radix `@radix-ui/react-alert-dialog`.
 *
 *  The primitive is the point. An alert dialog is the one overlay that must NOT go away when the user
 *  presses outside it: it asks a single question about an action already chosen, usually a destructive
 *  one, and a stray click on the backdrop is not an answer. Radix enforces that inside
 *  `AlertDialogContent`, so it cannot be undone by a call site the way a hand-written backdrop handler
 *  could. Escape still closes an idle confirmation, because cancelling IS the safe answer. While an
 *  asynchronous confirmation is running, every dismissal path is blocked so the result always has an
 *  owner and a second confirmation cannot race the first one.
 *
 *  Mounted only while open, like every overlay here: `useOverlayIsolation` captures the element to
 *  return focus to on its first render, and a component that stayed mounted while closed would capture
 *  whatever happened to be focused when the page loaded. */
export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  if (!open) return null;
  return <OpenConfirmDialog {...props} />;
}

function OpenConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmVariant = 'danger',
  pendingLabel,
  pending = false,
  disabled = false,
  error,
  onConfirm,
  onConfirmError,
  onClose,
}: Omit<ConfirmDialogProps, 'open'>) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);
  const activeRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [internalPending, setInternalPending] = useState(false);
  const [internalError, setInternalError] = useState<string>();
  useEffect(() => {
    activeRef.current = true;
    setMounted(true);
    return () => { activeRef.current = false; };
  }, []);
  const { restoreFocus } = useOverlayIsolation({ enabled: mounted, rootRef: overlayRef });
  const isPending = pending || internalPending;
  const blocked = disabled || isPending;
  const shownError = error ?? internalError;
  const close = () => { if (!blocked) onClose(); };

  const confirm = () => {
    if (blocked || confirmingRef.current) return;
    confirmingRef.current = true;
    setInternalError(undefined);

    let result: unknown;
    try {
      result = onConfirm();
    } catch (confirmError) {
      confirmingRef.current = false;
      setInternalError(errorMessage(confirmError, t.common.error));
      onConfirmError?.(confirmError);
      return;
    }

    if (!isPromiseLike(result)) {
      confirmingRef.current = false;
      return;
    }

    setInternalPending(true);
    void Promise.resolve(result).then(
      () => {
        confirmingRef.current = false;
        if (activeRef.current) setInternalPending(false);
      },
      (confirmError) => {
        confirmingRef.current = false;
        if (activeRef.current) {
          setInternalPending(false);
          setInternalError(errorMessage(confirmError, t.common.error));
          onConfirmError?.(confirmError);
        }
      },
    );
  };

  if (!mounted) return null;
  return createPortal(
    // A confirmation is a centered dialog wherever it is raised. It asks one question about the
    // action you just chose; sliding it in as a drawer would read as another settings surface.
    <AlertDialog open onOpenChange={(next) => { if (!next) close(); }}>
      <DialogOverlay ref={overlayRef} presentation="center">
        <AlertDialogContent
          ref={dialogRef}
          presentation="center"
          size="sm"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={isPending || undefined}
          data-elowen-modal
          onEscapeKeyDown={(event) => { if (blocked) event.preventDefault(); }}
          // A destructive question starts on its SAFE answer. The wrapper has no Radix Trigger, so keep
          // ownership of focus restoration below while explicitly choosing Cancel on entry.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogHeader title={title} titleId={titleId} icon={AlertTriangle} closeLabel={t.common.close} closeDisabled={blocked} onClose={close} />
          <ModalBody>
            {/* `whitespace-pre-line`: a confirmation that lists what is about to happen needs its lines to
                survive. Single-paragraph descriptions read identically. */}
            {description ? (
              <p id={descriptionId} className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
            {shownError ? <div className="mt-3 text-sm text-destructive" role="alert">{shownError}</div> : null}
          </ModalBody>
          <ModalFooter>
            <Button ref={cancelRef} variant="ghost" onClick={close} disabled={blocked}>{t.common.cancel}</Button>
            <Button variant={confirmVariant} onClick={confirm} disabled={blocked}>
              {isPending ? <Spinner tone="text-current" /> : null}
              {isPending ? (pendingLabel ?? confirmLabel ?? t.common.delete) : (confirmLabel ?? t.common.delete)}
            </Button>
          </ModalFooter>
        </AlertDialogContent>
      </DialogOverlay>
    </AlertDialog>,
    document.body,
  );
}
