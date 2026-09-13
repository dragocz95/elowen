'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Modal } from '../../components/ui/Modal';
import { useTranslation } from '../../lib/i18n';
import { useMobileViewport } from '../../lib/useMobile';
import { SettingsView } from './SettingsView';

/** Intercepted Settings presentation. The route remains `/settings?cat=…`; closing simply returns through
 *  browser history to the surface that opened it. A hard load never mounts this component and renders the
 *  canonical full page instead. */
export function SettingsOverlay() {
  const router = useRouter();
  const mobile = useMobileViewport();
  const { t } = useTranslation();
  // Geometry is part of the modal contract. Wait one effect for the real viewport instead of painting a
  // centered desktop window for one frame on a phone and then stretching it to fullscreen.
  if (mobile === undefined) return null;

  return (
    <Modal
      title={t.page.settings}
      icon={SlidersHorizontal}
      size="lg"
      intent="inspect"
      presentation={mobile ? 'fullscreen' : 'center'}
      closeLabel={t.common.close}
      onClose={() => router.back()}
      data-testid="settings-overlay"
    >
      <SettingsView surface="overlay" />
    </Modal>
  );
}
