/** The slot's answer for a HARD load: nothing is intercepted, so the canonical page under `app/` is the
 *  whole screen. Shared by every page presented as an overlay — `/settings` and `/account` alike. */
export default function PageOverlayDefault() {
  return null;
}
