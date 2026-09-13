/** Any route this slot does NOT intercept clears it. A parallel slot keeps whatever it last matched, so
 *  without this the overlay would stay on screen after navigating away from `/settings` or `/account`. */
export default function PageOverlayCatchAll() {
  return null;
}
