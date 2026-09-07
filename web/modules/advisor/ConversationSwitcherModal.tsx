'use client';
import { useState } from 'react';
import { Library } from 'lucide-react';
import { useTranslation } from '../../lib/i18n';
import { useMe } from '../../lib/queries';
import { useMobileViewport } from '../../lib/useMobile';
import { Modal, ModalBody } from '../../components/ui/Modal';
import { Segmented } from '../../components/ui/Segmented';
import { BrainSessionsPanel } from '../../components/brain/BrainSessionsPanel';
import { useBrainChat } from './BrainChatProvider';
import { ConversationHistoryPanel } from './ConversationHistoryPanel';

/** THE conversation switcher: one surface for every way into the conversation list, mounted ONCE by the
 *  shell beside the chat controller it reads its open state from. The dock and /chat can be on screen
 *  together, so a per-surface switcher would be two modals over one list.
 *
 *  "Just mine" is the caller's own conversations with their snippets, activity marks, row actions and
 *  filed schedules; "All conversations" is the administrator's register. A non-administrator has no
 *  second view.
 *
 *  This half holds no state on purpose. The shell keeps it mounted for the app's whole life, so anything
 *  remembered here would be remembered forever — and a switcher that reopens on the register is not what
 *  someone reaching for their own conversations asked for. Everything the reader chooses lives in the
 *  open modal below, and dies with it. */
export function ConversationSwitcherModal() {
  const { historyOpen, closeHistory } = useBrainChat();
  if (!historyOpen) return null;
  return <ConversationSwitcher onClose={closeHistory} />;
}

/** The open switcher. Its shape is deliberate rather than automatic: the register is a working surface
 *  with six columns, a search, a pager and nested confirmations, so the house rule's first-level
 *  right-hand drawer would be a peek from the side. A wide centered window instead, and the whole screen
 *  on a phone — which is what the shared rule answers there anyway, read from the shared viewport hook
 *  rather than a breakpoint written here. */
function ConversationSwitcher({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const phone = useMobileViewport() === true;
  const [view, setView] = useState<'mine' | 'all'>('mine');
  // An account that loses its admin rights while the modal is open must not keep the register on screen.
  const showing: 'mine' | 'all' = isAdmin ? view : 'mine';

  // ONE control, placed where there is room for it. The shared header is a single row — icon, title,
  // actions, close — and two sentence-long labels do not fit beside a title on a phone: the switch took
  // the row and the conversation list's own name was clipped to a letter. A phone gives it a line of its
  // own above the list, where both labels are readable and the track scrolls rather than breaking if the
  // screen is narrower still.
  const toggle = isAdmin ? (
    <Segmented
      size="sm"
      nowrap
      value={showing}
      onChange={(next) => setView(next as 'mine' | 'all')}
      aria-label={t.chat.historyTitle}
      options={[
        { value: 'mine', label: t.sessionsPanel.viewMine },
        { value: 'all', label: t.chat.openRegister },
      ]}
    />
  ) : null;

  return (
    <Modal
      title={t.chat.historyTitle}
      icon={Library}
      size="lg"
      presentation={phone ? 'fullscreen' : 'center'}
      // What the register is, said only where it is on screen: the personal list needs no explanation.
      {...(showing === 'all' ? { description: t.chat.registerHint } : {})}
      onClose={onClose}
      headerActions={phone ? undefined : toggle ?? undefined}
    >
      <ModalBody>
        {phone && toggle ? toggle : null}
        {/* Both views hand the chosen conversation to the chat surface behind this modal, so both dismiss
            it — the reader lands in what they opened rather than back on the list covering it. */}
        {showing === 'all'
          ? <BrainSessionsPanel afterOpen={onClose} />
          : <ConversationHistoryPanel onNavigate={onClose} homeLink={phone} />}
      </ModalBody>
    </Modal>
  );
}
