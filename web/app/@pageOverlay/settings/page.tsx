import { SettingsOverlay } from '../../../modules/settings/SettingsOverlay';

/** The slot's answer for an arrival that is NOT intercepted: a cold load, a hard refresh, a link from
 *  outside the app. Interception only ever answers a client navigation, so without this route the slot
 *  falls back to `default.tsx` and `/settings` arrives as a bare address with no presentation at all.
 *
 *  It renders the SAME overlay the interceptor does. That is the whole point: which of the two Next
 *  conventions matched is an accident of how the reader got here, and the page must not look different
 *  because of it. */
export default function SettingsSlotPage() {
  return <SettingsOverlay />;
}
