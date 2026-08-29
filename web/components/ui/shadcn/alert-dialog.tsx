'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';
import { dialogSurfaceVariants } from './dialog';

/** The shadcn/ui AlertDialog, on Radix `@radix-ui/react-alert-dialog`.
 *
 *  It is a different primitive from `Dialog` for one behavioural reason, and it is the reason this app
 *  uses it: an alert dialog CANNOT be dismissed by pressing outside it. Radix enforces that in the
 *  primitive — `AlertDialogContent` prevents the default on both `onPointerDownOutside` and
 *  `onInteractOutside` — so a confirmation cannot be lost by a stray click on the backdrop, which is
 *  exactly the mistake a destructive confirmation must not allow. Escape still closes it, because
 *  cancelling is the safe answer.
 *
 *  Everything the sibling `dialog.tsx` says about the missing Portal, the missing `Overlay` and the app
 *  policy layered on top applies here unchanged; the two share `dialogSurfaceVariants` so a confirmation
 *  and a centered dialog are the same object at two sizes. `components/ui/ConfirmDialog.tsx` is the
 *  app-shaped wrapper. */

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogContent({
  className = '',
  presentation = 'center',
  size = 'sm',
  ...props
  // `width` sizes a drawer, and a confirmation is never one.
}: React.ComponentProps<typeof AlertDialogPrimitive.Content> & Omit<VariantProps<typeof dialogSurfaceVariants>, 'width'>) {
  return (
    <AlertDialogPrimitive.Content
      data-slot="alert-dialog-content"
      // Radix sets `role="alertdialog"`; `aria-modal` is the caller's to state, as it is for `Dialog`.
      aria-modal="true"
      data-presentation={presentation}
      className={cn(dialogSurfaceVariants({ presentation, size }), className)}
      {...props}
    />
  );
}

export { AlertDialog, AlertDialogContent };
