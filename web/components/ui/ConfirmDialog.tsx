'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { ModalBody, ModalFooter } from './Modal';
import { Button, type ButtonVariant } from './Button';
import { useTranslation } from '../../lib/i18n';
import { focusOverlaySurface, useOverlayIsolation } from './overlayStack';
import { AlertDialog, AlertDialogContent } from './shadcn/alert-dialog';
import { DialogHeader, DialogOverlay } from './shadcn/dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  confirmDisabled?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

/** A confirmation, on the shadcn `AlertDialog` and therefore on Radix `@radix-ui/react-alert-dialog`.
 *
 *  The primitive is the point. An alert dialog is the one overlay that must NOT go away when the user
 *  presses outside it: it asks a single question about an action already chosen, usually a destructive
 *  one, and a stray click on the backdrop is not an answer. Radix enforces that inside
 *  `AlertDialogContent`, so it cannot be undone by a call site the way a hand-written backdrop handler
 *  could. Escape still closes it, because cancelling IS the safe answer.
 *
 *  Mounted only while open, like every overlay here: `useOverlayIsolation` captures the element to
 *  return focus to on its first render, and a component that stayed mounted while closed would capture
 *  whatever happened to be focused when the page loaded. */
export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  if (!open) return null;
  return <OpenConfirmDialog {...props} />;
}

function OpenConfirmDialog({ title, description, confirmLabel, confirmVariant = 'danger', confirmDisabled = false, onConfirm, onClose }: Omit<ConfirmDialogProps, 'open'>) {
  const { t } = useTranslation();
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { restoreFocus } = useOverlayIsolation({ enabled: mounted, rootRef: overlayRef });

  if (!mounted) return null;
  return createPortal(
    // A confirmation is a centered dialog wherever it is raised. It asks one question about the
    // action you just chose; sliding it in as a drawer would read as another settings surface.
    <AlertDialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogOverlay ref={overlayRef} presentation="center">
        <AlertDialogContent
          ref={dialogRef}
          presentation="center"
          size="sm"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          data-elowen-modal
          // The app's focus policy, as in `Modal`: anchor on the surface unless a control asked for it,
          // and hand focus back to whatever opened this — Radix would aim at a `Trigger` that does not
          // exist here, and `AlertDialog` would otherwise focus the cancel button.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (dialogRef.current) focusOverlaySurface(dialogRef.current);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus();
          }}
        >
          <DialogHeader title={title} titleId={titleId} icon={AlertTriangle} closeLabel={t.common.close} onClose={onClose} />
          <ModalBody>
            {/* `whitespace-pre-line`: a confirmation that lists what is about to happen needs its lines to
                survive. Single-paragraph descriptions read identically. */}
            {description ? (
              <p id={descriptionId} className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
            <Button variant={confirmVariant} disabled={confirmDisabled} onClick={() => { void onConfirm(); }}>{confirmLabel ?? t.common.delete}</Button>
          </ModalFooter>
        </AlertDialogContent>
      </DialogOverlay>
    </AlertDialog>,
    document.body,
  );
}
