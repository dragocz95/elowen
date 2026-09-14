'use client';

import { UserCog } from 'lucide-react';
import { PageOverlay } from '../../components/ui/PageOverlay';
import { useTranslation } from '../../lib/i18n';
import { AccountView } from './AccountView';

/** THE Account presentation, mounted by the `@pageOverlay` slot for every arrival — an intercepted
 *  navigation, a cold load, a shared link. The route remains `/account?cat=…` and closing returns to the
 *  surface that opened it. The frame is the same shared page-overlay contract `/settings` is presented in
 *  — see components/ui/PageOverlay.tsx. */
export function AccountOverlay() {
  const { t } = useTranslation();
  return (
    <PageOverlay title={t.account.title} icon={UserCog} frame="reading" data-testid="account-overlay">
      <AccountView />
    </PageOverlay>
  );
}
