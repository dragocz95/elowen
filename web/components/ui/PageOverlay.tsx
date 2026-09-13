'use client';

import type { LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { useTranslation } from '../../lib/i18n';
import { useMobileViewport } from '../../lib/useMobile';

/** The frame an INTERCEPTED PAGE is presented in. `/settings` and `/account` are routes rather than
 *  dialogs: opened from the shell they appear over the surface that linked to them, and a hard load or an
 *  external link still renders the canonical full page (the intercepting route under `app/@pageOverlay`
 *  is simply never mounted then).
 *
 *  Everything about that presentation is the same for both, which is why it is stated once here instead
 *  of twice: the centered desktop window, the phone's full screen, the page z-band UNDER the drawers the
 *  page itself opens (`standsInForPage`, see components/ui/Modal.tsx), and closing by walking back through
 *  history to wherever the reader came from. The two overlays differ in nothing but their title, their
 *  icon and their content. */
export function PageOverlay({ title, icon, children, 'data-testid': testId }: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** Addresses the overlay surface itself from a test. */
  'data-testid'?: string;
}) {
  const router = useRouter();
  const mobile = useMobileViewport();
  const { t } = useTranslation();
  // Geometry is part of the modal contract. Wait one effect for the real viewport instead of painting a
  // centered desktop window for one frame on a phone and then stretching it to fullscreen.
  if (mobile === undefined) return null;

  return (
    <Modal
      title={title}
      icon={icon}
      size="page"
      intent="inspect"
      presentation={mobile ? 'fullscreen' : 'center'}
      standsInForPage
      closeLabel={t.common.close}
      onClose={() => router.back()}
      data-testid={testId}
    >
      {children}
    </Modal>
  );
}
