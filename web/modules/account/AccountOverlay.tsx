'use client';

import { UserCog } from 'lucide-react';
import { PageOverlay } from '../../components/ui/PageOverlay';
import { useTranslation } from '../../lib/i18n';
import { AccountView } from './AccountView';

/** Intercepted Account presentation. The route remains `/account?cat=…`; closing returns through browser
 *  history to the surface that opened it, and a hard load or an external link never mounts this component
 *  and renders the canonical full page instead. The frame is the same shared page-overlay contract
 *  `/settings` is presented in — see components/ui/PageOverlay.tsx. */
export function AccountOverlay() {
  const { t } = useTranslation();
  return (
    <PageOverlay title={t.account.title} icon={UserCog} data-testid="account-overlay">
      <AccountView surface="overlay" />
    </PageOverlay>
  );
}
