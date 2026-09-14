'use client';

import { SlidersHorizontal } from 'lucide-react';
import { PageOverlay } from '../../components/ui/PageOverlay';
import { useTranslation } from '../../lib/i18n';
import { SettingsView } from './SettingsView';

/** THE Settings presentation. The route remains `/settings?cat=…`; closing returns to the surface that
 *  opened it, or to a real page when nothing of this app's is behind it. Every arrival is drawn by this
 *  one component — the `@pageOverlay` slot mounts it for an intercepted navigation and for a hard load
 *  alike — so the deck cannot look like two different products depending on how the reader got here. The
 *  frame itself — z-band, focus and dismissal — is the shared page-overlay contract in
 *  components/ui/PageOverlay.tsx, which `/account` is presented in too. This
 *  page is the one that asks for the READING measure: its records read as a label at one edge and a
 *  control at the other, so the frame is capped rather than grown to the window. */
export function SettingsOverlay() {
  const { t } = useTranslation();
  return (
    <PageOverlay title={t.page.settings} icon={SlidersHorizontal} frame="reading" data-testid="settings-overlay">
      <SettingsView />
    </PageOverlay>
  );
}
