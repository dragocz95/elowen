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

/** THE conversation switcher. One surface for every way into the conversation list: the /chat header, the
 *  dock's conversation name, and anything else that needs to change conversation. There used to be three
 *  (a left rail, a phone drawer, a dock popover) plus a separate register modal, which meant two answers
 *  to "where do I switch conversation" and two lists to keep in step.
 *
 *  Its shape is deliberate rather than automatic: the register is a working surface with six columns, a
 *  search, a pager and nested confirmations, so the house rule's first-level right-hand drawer would be a
 *  peek from the side. It is a wide centered window instead, and the whole screen on a phone — which is
 *  what `resolveOverlayPresentation` answers there anyway, read from the same shared viewport hook rather
 *  than a breakpoint written here.
 *
 *  "Just mine" is the caller's own conversations with their search snippets, activity marks, row actions
 *  and the collapsed branch of schedules filed under each. "All" is the administrator's register — every
 *  account's conversations, with delegated sessions nested under the conversation that started them. A
 *  non-administrator has no second view and is shown the list alone.
 *
 *  It is mounted ONCE, by the shell beside the chat controller, and reads its open state from that
 *  controller — the same reason the reconnect overlay is mounted once: the dock and /chat can be on
 *  screen together, and a per-surface switcher would be two modals over one conversation list. */
export function ConversationSwitcherModal() {
  const { historyOpen: open, closeHistory: onClose } = useBrainChat();
  const { t } = useTranslation();
  const me = useMe();
  const isAdmin = me.data?.user?.is_admin ?? false;
  const phone = useMobileViewport() === true;
  const [view, setView] = useState<'mine' | 'all'>('mine');
  // An account that loses its admin rights while the modal is open must not keep the register on screen.
  const showing: 'mine' | 'all' = isAdmin ? view : 'mine';

  if (!open) return null;
  return (
    <Modal
      title={t.chat.historyTitle}
      icon={Library}
      size="lg"
      presentation={phone ? 'fullscreen' : 'center'}
      // What the register is, said only where it is on screen: the personal list needs no explanation.
      {...(showing === 'all' ? { description: t.chat.registerHint } : {})}
      onClose={onClose}
      headerActions={isAdmin ? (
        <Segmented
          size="sm"
          value={showing}
          onChange={(next) => setView(next as 'mine' | 'all')}
          aria-label={t.chat.historyTitle}
          options={[
            { value: 'mine', label: t.sessionsPanel.viewMine },
            { value: 'all', label: t.chat.openRegister },
          ]}
        />
      ) : undefined}
    >
      <ModalBody>
        {/* Both views hand the chosen conversation to the chat surface behind this modal, so both dismiss
            it — the reader lands in what they opened rather than back on the list covering it. */}
        {showing === 'all'
          ? <BrainSessionsPanel afterOpen={onClose} lockedView="all" />
          : <ConversationHistoryPanel onNavigate={onClose} homeLink={phone} />}
      </ModalBody>
    </Modal>
  );
}
