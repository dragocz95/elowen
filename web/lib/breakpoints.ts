/** The layout breakpoint ladder — one source of truth for the JS that decides layout and the CSS that
 *  styles it. A number here has a mirror in `web/app/styles/`; the two must move together, because a
 *  hook that thinks the window is a phone while the stylesheet thinks it is a tablet produces a layout
 *  neither of them describes.
 *
 *  WHAT IS MEASURED. Every value is CSS pixels of the LAYOUT viewport — the coordinate system `@media`
 *  and `@container` queries evaluate in. Both consumers read that same system:
 *    - `useMobileViewport()` runs a `matchMedia` on the viewport;
 *    - `resolveNav()` reads a `ResizeObserver` `contentRect`, which reports local CSS px, and asks about
 *      the region the shell actually owns (window − advisor dock) rather than the whole window, so
 *      dragging the dock re-chromes the app exactly like resizing it.
 *  They therefore answer different QUESTIONS — "how wide is the screen" versus "how much room do I have"
 *  — in the same UNIT. That distinction is deliberate; a unit mismatch would not be.
 *
 *  There is no whole-app zoom between the two any more. An automatic width-derived `zoom` on <html> used
 *  to sit there and inflate the layout viewport, so `window.innerWidth` and a measured element width
 *  disagreed by 1/zoom and CSS breakpoints fired against a viewport no window ever had. Sizing is real
 *  responsive CSS now; only the explicit per-device Account preference still applies a zoom, and it
 *  scales the layout viewport that BOTH consumers read, so they stay in agreement. */

/** At or below this width the device is a phone: one column, drawer navigation, full-screen surfaces.
 *  768px (Tailwind's `md`) minus one, so `max-[767px]` is the exact complement of the `md:` utilities. */
export const PHONE_MAX_WIDTH = 767;

/** At or below this the device is a tablet — roomier than a phone, still a single reading column with
 *  no side rails. 1024px (Tailwind's `lg`) minus one. */
export const TABLET_MAX_WIDTH = 1023;

/** Below this much room the navigation has no column of its own and slides in over the content from a
 *  hamburger. Set one past the phone breakpoint so a phone-width region and a phone-width viewport are
 *  never classified differently. */
export const NAV_COLUMN_MIN_WIDTH = PHONE_MAX_WIDTH + 1;

/** Below this much room the navigation column is forced to its icon rail, so the content keeps usable
 *  width; at or above it the user's own pin decides and the collapse handle is offered. 1280px is
 *  Tailwind's `xl` and the narrowest common laptop, which is exactly the window that should still get
 *  the choice rather than have it made for it. */
export const NAV_FULL_MIN_WIDTH = 1280;
