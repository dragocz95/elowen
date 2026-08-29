'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Toast, on Radix `@radix-ui/react-toast`.
 *
 *  This file is the shadcn component itself — its anatomy, its `data-slot` attributes and its prop
 *  surface are shadcn's, and the parts are exported individually so a call site composes them. What is
 *  ours is only the styling, which reads this app's design tokens instead of shadcn's default palette.
 *  `components/ui/Toast.tsx` is the app-shaped wrapper (the `useToast` hook and the provider that owns
 *  the app's status and duration policy) and is what all 35 importers use.
 *
 *  IN `ui/shadcn/` RATHER THAN BESIDE ITS WRAPPER, unlike `ui/select.tsx`. A shadcn primitive keeps its
 *  own lowercase name, and here that name collides with the app component's: TypeScript refuses to
 *  include `toast.tsx` and `Toast.tsx` from a single directory (TS1149 — file names differing only in
 *  casing), and no tsconfig setting relaxes it. The subdirectory gives the primitive its canonical name
 *  back; note the extra level it puts in the `cn` import above.
 *
 *  Behaviour is Radix's and is NOT reimplemented here: the close timer with its pause on hover, focus
 *  and window blur, swipe-to-dismiss, the F8 viewport hotkey, tab order through stacked toasts, and the
 *  visually-hidden live region that actually gets a toast announced. Radix portals each toast into the
 *  VIEWPORT node (not into `<body>`), so the "delete the Portal" rule has nothing to remove here — see
 *  `Toast.tsx` for the note on how that interacts with the app's overlay isolation. */

const ToastProvider = ToastPrimitive.Provider;

/** THE ONE PLACE IN THIS KIT THAT IS DELIBERATELY PORTALED, against the migration's own rule.
 *
 *  The rule exists so a menu cannot fall out of the dialog it belongs to. A toast is the opposite case:
 *  it does not belong to the dialog, it has to OUTLIVE it. Rendered in the app tree it is a descendant
 *  of the node an open overlay marks `inert`, and `inert` applies to a whole subtree with no way to opt
 *  out from within — so the toast painted above the dialog (--z-toast is above --z-modal) while being
 *  unclickable, which is the exact opposite of what that stacking order promises.
 *
 *  Being a child of `<body>` is only half of it; there are TWO independent sweeps over those children
 *  and each has its own opt-out, so the dock has to answer both or the defect just changes attribute:
 *    - the app's own (`overlayStack.syncIsolation`) skips `data-overlay-exempt`;
 *    - Radix's modal dialog runs `aria-hidden`'s `hideOthers`, which spares `[aria-live]`.
 *
 *  `aria-live` is "off" rather than "polite" on purpose. Radix's exemption tests for the ATTRIBUTE, not
 *  its value, so "off" is enough to be spared — and it avoids making the dock a third announcing region
 *  next to Radix's hidden announce node and the `role="status"`/`role="alert"` on each card. A container
 *  that announced its own children would have every toast read twice. */
function ToastViewport({ className = '', ...props }: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  // Mount-gated because `createPortal` needs `document` and the provider renders during SSR.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  // The exemption goes on a wrapper of our own, not on the Viewport, because Radix wraps the list in a
  // `<div role="region">` of its own — so THAT is the child of `<body>` the two sweeps walk, and
  // attributes set on the list underneath it are never looked at. The wrapper is unstyled on purpose: it
  // generates an empty, zero-height box, and the dock inside it is `position: fixed`, so it costs the
  // layout nothing while giving both sweeps a node to skip.
  return createPortal(
    <div data-slot="toast-dock" data-overlay-exempt aria-live="off">
    <ToastPrimitive.Viewport
      data-slot="toast-viewport"
      // `overlay-toast-dock` is the app's toast layer and owns placement, gap and safe-area insets in
      // one place (styles/components/primitives.css): bottom-right on a phone, clear of the advisor
      // launcher, and the conventional top-right column from the tablet breakpoint up. It sits on
      // --z-toast, which tokens.css deliberately puts ABOVE --z-modal, because a message about what
      // just happened has to stay readable over the dialog that caused it. Do not add a `z-` utility
      // here; the stacking order is defined once, in tokens.css.
      className={cn('overlay-toast-dock pointer-events-none', className)}
      {...props}
    />
    </div>,
    document.body,
  );
}

const toastVariants = cva(
  [
    'pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg border',
    'py-2.5 pl-3 pr-2.5 shadow-[var(--shadow-raised)] sm:gap-3 sm:py-3 sm:pl-4 sm:pr-3',
    // Radix drives the swipe gesture through these two custom properties; without the transforms the
    // toast does not follow the pointer and the gesture reads as broken rather than absent.
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
    'data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
  ],
  {
    variants: {
      // A status fill is one of the few places the app paints a saturated surface, so each variant
      // carries its OWN `-foreground` beside its fill rather than one shared ink on the base class —
      // that is the shadcn pairing rule, and it is what lets a skin split the two inks apart. The border
      // is the fill darkened toward that same ink: a flat edge disappears against the fill, and mixing
      // (rather than hardcoding a second colour) keeps the edge correct when a skin repaints the status
      // colours.
      status: {
        success: 'bg-success text-success-foreground border-[color-mix(in_srgb,var(--color-success)_72%,var(--color-success-foreground))]',
        error: 'bg-destructive text-destructive-foreground border-[color-mix(in_srgb,var(--color-destructive)_72%,var(--color-destructive-foreground))]',
      },
    },
    defaultVariants: { status: 'success' },
  },
);

type ToastStatus = NonNullable<VariantProps<typeof toastVariants>['status']>;

function Toast({
  className = '',
  status,
  ...props
}: React.ComponentProps<typeof ToastPrimitive.Root> & VariantProps<typeof toastVariants>) {
  return (
    <ToastPrimitive.Root
      data-slot="toast"
      className={cn(toastVariants({ status }), className)}
      // Inline rather than a utility on purpose: `toast-in` is a hand-written keyframe in
      // styles/animations.css with no `.animate-toast-in` class and no `--animate-*` theme entry to
      // generate one from, and adding either means editing a shared stylesheet. It still answers the
      // quiet-effects settings, because the keyframe's travel is `--motion-distance-md`, which those
      // modes set to 0px.
      style={{ animation: 'toast-in 200ms var(--ease-out)' }}
      {...props}
    />
  );
}

function ToastTitle({ className = '', ...props }: React.ComponentProps<typeof ToastPrimitive.Title>) {
  return (
    <ToastPrimitive.Title
      data-slot="toast-title"
      className={cn('text-[13px] font-semibold sm:text-sm', className)}
      {...props}
    />
  );
}

function ToastDescription({ className = '', ...props }: React.ComponentProps<typeof ToastPrimitive.Description>) {
  return (
    <ToastPrimitive.Description
      data-slot="toast-description"
      className={cn('mt-0.5 break-words text-[13px] leading-snug sm:text-sm', className)}
      {...props}
    />
  );
}

function ToastClose({ className = '', ...props }: React.ComponentProps<typeof ToastPrimitive.Close>) {
  return (
    <ToastPrimitive.Close
      data-slot="toast-close"
      className={cn(
        'overlay-touch-target -mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
        // `current` rather than a named ink: the close sits INSIDE a variant fill and inherits that
        // variant's `-foreground`, so a wash of the inherited colour is correct for every status and for
        // any status a skin adds, where naming one of them would be right for one card and wrong on the next.
        'opacity-75 transition-opacity hover:bg-current/10 hover:opacity-100 sm:h-7 sm:w-7',
        className,
      )}
      {...props}
    />
  );
}

export { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport, type ToastStatus };
