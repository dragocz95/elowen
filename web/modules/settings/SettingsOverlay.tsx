'use client';

import { SlidersHorizontal } from 'lucide-react';
import { PageOverlay } from '../../components/ui/PageOverlay';
import { useTranslation } from '../../lib/i18n';
import { SettingsView } from './SettingsView';

/** Intercepted Settings presentation. The route remains `/settings?cat=…`; closing simply returns through
 *  browser history to the surface that opened it. A hard load never mounts this component and renders the
 *  canonical full page instead. The frame itself — geometry, z-band, focus and dismissal — is the shared
 *  page-overlay contract in components/ui/PageOverlay.tsx, which `/account` is presented in too. */
export function SettingsOverlay() {
  const { t } = useTranslation();
  return (
    <PageOverlay title={t.page.settings} icon={SlidersHorizontal} data-testid="settings-overlay">
      <SettingsView surface="overlay" />
    </PageOverlay>
  );
}
