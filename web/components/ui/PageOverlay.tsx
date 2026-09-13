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
 *  of twice: the phone's full screen, the page z-band UNDER the drawers the page itself opens
 *  (`standsInForPage`, see components/ui/Modal.tsx), and closing by walking back through history to
 *  wherever the reader came from.
 *
 *  `frame` is the ONE axis on which the two are allowed to differ, and it is opt-in so that adding a
 *  third intercepted page cannot silently inherit a measure chosen for Settings. `window` is the frame
 *  both pages have always had. `reading` caps the centered window at the shared content measure and at a
 *  fixed height, for a page whose content is a stack of records read left to right — Settings, whose
 *  label and control sit at opposite edges of the frame. A caller that does not ask, does not get it. */
export function PageOverlay({ title, icon, children, frame = 'window', 'data-testid': testId }: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  /** `window` is the shared centered frame; `reading` caps it at `--content-max` and a fixed height. */
  frame?: 'window' | 'reading';
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
      size={frame === 'reading' ? 'page' : 'lg'}
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
