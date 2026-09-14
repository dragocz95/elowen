'use client';

import type { LucideIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { useTranslation } from '../../lib/i18n';
import { useMobileViewport } from '../../lib/useMobile';
import { PAGE_OVERLAY_FALLBACK_ROUTE, hasAppHistoryBehind } from '../../lib/pageOverlayReturn';

/** The frame a PAGE PRESENTED AS AN OVERLAY is drawn in. `/settings` and `/account` are routes rather
 *  than dialogs: opened from the shell they appear over the surface that linked to them, and every other
 *  arrival — a cold load, a refresh, a shared link — is presented the same way, because the `@pageOverlay`
 *  slot answers an intercepted navigation and a plain one with this same frame (`app/@pageOverlay`).
 *
 *  Everything about that presentation is the same for both, which is why it is stated once here instead
 *  of twice: the phone's full screen, the page z-band UNDER the drawers the page itself opens
 *  (`standsInForPage`, see components/ui/Modal.tsx), and closing by walking back through history to
 *  wherever the reader came from.
 *
 *  `frame` is an explicit content choice rather than an inference from the route. `window` is the broad
 *  data frame. `reading` caps the centered window at the shared content measure and a fixed height for a
 *  page whose content is a stack of records read left to right. Settings and Account both use that same
 *  reading frame; a future intercepted data page can still choose the broader window deliberately. */
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
      // Closing LEAVES the address, because this overlay is a page. Stepping back is what returns the
      // reader to the surface they opened it from; with nothing of this app's behind the current entry —
      // a cold load, a shared link, a new tab — stepping back is a no-op at best and an exit from the app
      // at worst, so the close goes to a real page instead. See lib/pageOverlayReturn.ts.
      onClose={() => { if (hasAppHistoryBehind()) router.back(); else router.replace(PAGE_OVERLAY_FALLBACK_ROUTE); }}
      data-testid={testId}
    >
      {children}
    </Modal>
  );
}
