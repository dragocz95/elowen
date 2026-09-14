import { AccountOverlay } from '../../../modules/account/AccountOverlay';

/** The slot's answer for an arrival that is NOT intercepted — see the sibling `settings/page.tsx` for
 *  why the plain route exists beside the interceptor and why both render the same overlay. */
export default function AccountSlotPage() {
  return <AccountOverlay />;
}
