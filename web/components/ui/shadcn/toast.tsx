'use client';

import * as React from 'react';
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

function ToastViewport({ className = '', ...props }: React.ComponentProps<typeof ToastPrimitive.Viewport>) {
  return (
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
  );
}

const toastVariants = cva(
  [
    'pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg border',
    'py-2.5 pl-3 pr-2.5 text-on-status shadow-[var(--shadow-raised)] sm:gap-3 sm:py-3 sm:pl-4 sm:pr-3',
    // Radix drives the swipe gesture through these two custom properties; without the transforms the
    // toast does not follow the pointer and the gesture reads as broken rather than absent.
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
    'data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)]',
  ],
  {
    variants: {
      // A status fill is one of the few places the app paints a saturated surface, so the text on it is
      // `on-status` rather than any of the ordinary foregrounds. The border is the fill darkened toward
      // that same ink: a flat edge disappears against the fill, and mixing (rather than hardcoding a
      // second colour) keeps the edge correct when a skin repaints the status colours.
      status: {
        success: 'bg-success border-[color-mix(in_srgb,var(--color-success)_72%,var(--color-on-status))]',
        error: 'bg-destructive border-[color-mix(in_srgb,var(--color-destructive)_72%,var(--color-on-status))]',
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
        'opacity-75 transition-opacity hover:bg-on-status/10 hover:opacity-100 sm:h-7 sm:w-7',
        className,
      )}
      {...props}
    />
  );
}

export { Toast, ToastClose, ToastDescription, ToastProvider, ToastTitle, ToastViewport, type ToastStatus };
