'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import type { LucideIcon } from 'lucide-react';

import { cn } from '../../../lib/utils';

/** The shadcn/ui Dialog, on Radix `@radix-ui/react-dialog`.
 *
 *  Radix owns what a dialog owes the keyboard and the screen reader: the focus trap, Tab looping,
 *  Escape, layer ordering among several open dialogs, and the `data-state` the animations key off.
 *  None of that is reimplemented here.
 *
 *  What is NOT Radix's, and survives on top of it, is this app's overlay policy —
 *  `components/ui/overlayStack.ts` (stack ownership, `inert` isolation, scroll lock, focus return) and
 *  `components/ui/overlayDepth.tsx` (nesting depth and the phone presentation). `components/ui/Modal.tsx`
 *  is the app-shaped wrapper that binds the two together and is what the app imports.
 *
 *  TWO DELIBERATE DEPARTURES FROM STOCK shadcn, both of which `shadcn add dialog` will undo:
 *
 *  1. NO `Dialog.Portal`. The app portals the whole overlay itself, once, at `DialogOverlay` (see
 *     `Modal.tsx`). Radix's portal would reparent the CONTENT alone into a second, separate child of
 *     <body>, which splits the surface from the backdrop that positions it and hands `overlayStack` two
 *     body children per overlay — it would mark the loose one `inert` as "not the top of the stack".
 *     Menus opened INSIDE a dialog are not portaled either (`select.tsx` carries the same rule), so they
 *     stay within the dialog's focus scope instead of being pulled out of it.
 *  2. NO `Dialog.Overlay` for the backdrop. Radix's overlay is a second dismissable surface with a
 *     scroll lock of its own; the app already locks the body from the overlay stack, and the backdrop
 *     here carries app policy Radix has no notion of (which presentation it is laying out, and that a
 *     nested dialog's backdrop must not also close its parent). */

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

/** The layer an overlay paints on: the scrim, a z-index band from the shared scale, and the box that
 *  positions the surface.
 *
 *  Both variant axes are this app's own. `presentation` is resolved from overlay depth and viewport by
 *  `overlayDepth.tsx` and is never chosen at a call site. `layer` follows the overlay's INTENT: a
 *  surface you read and dismiss — a detail rail, a record card — belongs to the drawer band, and an
 *  editing dialog belongs to the modal band above it, so a dialog raised from a rail paints over the
 *  rail it came from rather than fighting it for DOM order. `Modal.tsx` derives it; nothing else picks
 *  it by hand. */
const dialogOverlayVariants = cva('fixed inset-0 flex', {
  variants: {
    presentation: {
      center: 'items-center justify-center',
      drawer: 'justify-end',
      // A sheet and a fullscreen surface are laid out by `.overlay-surface[data-presentation]`, which
      // owns the dvh height and the safe-area insets for every overlay in the app; the layer only has to
      // get out of their way.
      sheet: 'items-stretch justify-stretch p-0',
      fullscreen: 'items-stretch justify-stretch p-0',
    },
    // The classes assign the bands from tokens.css (app/styles/components/primitives.css); no overlay in
    // this app may name a band with a literal. `page` is the lowest of the three: an intercepted route
    // presented as an overlay stands in for its page, so it ranks UNDER the drawers and dialogs it opens.
    layer: {
      page: 'overlay-layer-page',
      drawer: 'overlay-layer-drawer',
      modal: 'overlay-layer-modal',
    },
    scrim: {
      default: 'bg-[var(--color-scrim)]',
      soft: 'bg-[var(--color-scrim-soft)]',
    },
  },
  defaultVariants: { presentation: 'center', layer: 'modal', scrim: 'default' },
});

type DialogPresentation = NonNullable<VariantProps<typeof dialogOverlayVariants>['presentation']>;
type DialogLayer = NonNullable<VariantProps<typeof dialogOverlayVariants>['layer']>;
type DialogScrim = NonNullable<VariantProps<typeof dialogOverlayVariants>['scrim']>;

function DialogOverlay({
  className = '',
  presentation = 'center',
  layer = 'modal',
  scrim = 'default',
  style,
  ...props
}: React.ComponentProps<'div'> & { presentation?: DialogPresentation; layer?: DialogLayer; scrim?: DialogScrim }) {
  return (
    <div
      data-slot="dialog-overlay"
      data-scrim={scrim}
      className={cn(dialogOverlayVariants({ presentation, layer, scrim }), className)}
      style={{
        // Radix's modal content sets `pointer-events: none` on <body> so that nothing outside it can be
        // pressed, and re-enables them on itself. This layer is a child of <body> and would inherit the
        // block, which would kill the click-outside-to-close on the backdrop — silently, because jsdom
        // does not implement pointer-events. Opting back in is exactly what Radix's own `Dialog.Overlay`
        // does for the same reason.
        pointerEvents: 'auto',
        // A centered dialog keeps its 1rem breathing room, widened to the safe area where the device has
        // one — in landscape the notch is on a SIDE, so a fixed inset is not enough on its own. The other
        // presentations get their insets from `.overlay-surface`.
        ...(presentation === 'center'
          ? {
            paddingBlock: 'max(1rem, var(--safe-top)) max(1rem, var(--safe-bottom))',
            paddingInline: 'max(1rem, var(--safe-left)) max(1rem, var(--safe-right))',
          }
          : null),
        ...style,
      }}
      {...props}
    />
  );
}

/** The surface itself. `presentation` picks the shape, `size` the room a centered window takes and
 *  `width` the room a drawer takes; the two size axes are compound rather than free because a drawer has
 *  no use for `max-w-lg` and a centered window has no use for a drawer width.
 *
 *  `.overlay-surface` is what `app/styles/components/primitives.css` paints (background, border colour,
 *  raised shadow) and what dresses the two phone presentations geometrically. The variants below own the
 *  shape and nothing else: border WIDTH and which edges are drawn is geometry; the colour of that border
 *  is not.
 *
 *  dvh throughout: a mobile browser's collapsing toolbar makes `vh` taller than the screen actually is,
 *  which put the footer of every one of these under the browser chrome.
 *
 *  `chrome` is the one axis that asks whether this surface IS a panel. `card` — the default, and what
 *  every dialog, drawer and sheet in the app wears — carries the shared material, the drawn edge and the
 *  size a panel needs room for. `bare` declines all three: a surface whose content IS the frame (the chat
 *  image lightbox) must not paint a ground, an edge, a shadow or a `max-w-lg` over the picture the reader
 *  clicked, or the lightbox is a card again. Everything else is shared and unchanged: the same primitive,
 *  the same focus trap, Escape, layer order, inert isolation and scroll lock. */
const dialogSurfaceVariants = cva('flex flex-col focus:outline-none', {
  variants: {
    presentation: {
      center: 'animate-pop-in',
      drawer: 'animate-drawer-in h-full rounded-l-lg border-l',
      sheet: 'min-h-0 w-full',
      fullscreen: 'animate-pop-in relative min-h-0 w-full',
    },
    chrome: { card: 'overlay-surface', bare: '' },
    size: { sm: '', md: '', lg: '', xl: '', page: '' },
    width: { default: '', wide: '' },
  },
  compoundVariants: [
    // The drawn edge and the room both belong to a PANEL, so both are gated on the chrome: a bare surface
    // takes exactly what its content takes.
    { presentation: 'center', chrome: 'card', class: 'rounded-lg border' },
    { presentation: 'fullscreen', chrome: 'card', class: 'border' },
    { presentation: 'center', chrome: 'bare', class: 'h-full w-full items-center justify-center' },
    { presentation: 'center', chrome: 'card', size: 'lg', class: 'h-[88dvh] w-[92vw] max-w-[90rem]' },
    // The READING frame, taken by an intercepted page that is a stack of records rather than a data
    // surface — both Settings and Account ask for `PageOverlay frame="reading"`. `lg` beside it is the DATA
    // window that wants every pixel a monitor has (a log table, a diagnostics run), so it grows to 90rem by
    // 88dvh.
    //
    // The width is not a number of its own. `--content-max` (app/styles/tokens.css) is the single
    // authority for how wide a workspace may grow; every shell and content surface already reads it and
    // a skin moves it to suit its own measure, so restating a cap here is the one thing that token
    // forbids. The height IS stated, because this frame has to hold still while sections of very
    // different lengths are swapped through it.
    { presentation: 'center', chrome: 'card', size: 'page', class: 'h-[min(88dvh,50rem)] w-[92vw] max-w-[var(--content-max)]' },
    { presentation: 'center', chrome: 'card', size: 'xl', class: 'max-h-[90dvh] w-full max-w-2xl' },
    { presentation: 'center', chrome: 'card', size: 'md', class: 'max-h-[88dvh] w-full max-w-lg' },
    { presentation: 'center', chrome: 'card', size: 'sm', class: 'max-h-[80dvh] w-full max-w-md' },
    { presentation: 'drawer', width: 'default', class: 'w-[min(38rem,calc(100vw-3rem))]' },
    { presentation: 'drawer', width: 'wide', class: 'w-[min(72rem,calc(100vw-3rem))]' },
  ],
  defaultVariants: { presentation: 'center', chrome: 'card', size: 'md', width: 'default' },
});

function DialogContent({
  className = '',
  presentation = 'center',
  // Whether this surface IS a panel. `card` is every dialog, drawer and sheet in the app. `bare` is one
  // whose content is the whole frame — the chat image lightbox, where a ground, an edge, a cast shadow and
  // the room a panel reserves for a title would all be a card drawn over the picture the reader clicked.
  // What `bare` keeps is everything that was never visual: the same primitive, the same focus trap,
  // Escape, layer order, inert isolation and scroll lock.
  chrome = 'card',
  size = 'md',
  width = 'default',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & VariantProps<typeof dialogSurfaceVariants>) {
  return (
    <DialogPrimitive.Content
      data-slot="dialog-content"
      // Radix sets `role="dialog"` but leaves `aria-modal` to the caller, because a non-modal Radix
      // dialog uses the same content part. Every dialog in this app isolates the page behind it, so it
      // is a modal one and says so.
      aria-modal="true"
      data-presentation={presentation}
      // Stated on the DOM as well as in the class list, so a browser test can see which of the two the
      // surface was built as.
      data-chrome={chrome}
      // `focus:outline-none` on the surface itself: the overlay focuses this element on open so the focus
      // trap and screen readers have an anchor, but it is `tabIndex={-1}` and not interactive, so the
      // browser's ring around the whole window says nothing. Opening a dialog from the keyboard — a slash
      // command, for instance — made `:focus-visible` match and drew a bright outline around the entire
      // dialog that vanished on the first click inside. Controls INSIDE keep their own rings.
      className={cn(dialogSurfaceVariants({ presentation, chrome, size, width }), className)}
      {...props}
    />
  );
}

/** The header every overlay in this app shares: an optional icon badge, the title and its one-line
 *  description, call-site actions, and the close control. Plain markup with no Radix coupling, so the
 *  alert dialog can wear the same chrome — `alert-dialog.tsx` composes this too.
 *
 *  The ids are passed in rather than taken from a `Dialog.Title`: the same header serves two different
 *  Radix scopes, and a `Dialog.Title` rendered inside an `AlertDialog` reads the wrong context. */
function DialogHeader({
  title,
  titleId,
  description,
  descriptionId,
  icon: Icon,
  actions,
  closeLabel,
  closeDisabled = false,
  onClose,
}: {
  title: string;
  titleId: string;
  description?: string;
  descriptionId?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  closeLabel: string;
  closeDisabled?: boolean;
  onClose: () => void;
}) {
  return (
    <div data-slot="dialog-header" className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
      {Icon ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
          <Icon size={18} className="text-primary" aria-hidden />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 id={titleId} data-slot="dialog-title" className="truncate text-sm font-semibold text-foreground">{title}</h2>
        {description ? (
          <p id={descriptionId} data-slot="dialog-description" className="truncate text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      <button
        type="button"
        aria-label={closeLabel}
        disabled={closeDisabled}
        onClick={onClose}
        // `accent` is the shadcn token for an interactive surface, and in this app it resolves to a wash
        // of the foreground rather than a step up the surface ramp — a step both designs are free to
        // collapse, and studio-oled does.
        className="overlay-touch-target flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        ×
      </button>
    </div>
  );
}

// Only what a wrapper composes: `dialogSurfaceVariants` is shared with `alert-dialog.tsx` so a
// confirmation and a centered dialog stay one object at two sizes.
export { Dialog, DialogContent, DialogHeader, DialogOverlay, dialogSurfaceVariants };
