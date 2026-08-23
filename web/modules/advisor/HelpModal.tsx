'use client';

import { useMemo, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useTranslation } from '../../lib/i18n';
import { Input } from '../../components/ui/Input';
import { EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';

/** The web dock's `/help` overlay. It used to be a toast of bare command names glued together with spaces —
 *  every description dropped, unreadable past a handful of entries, and gone before it could be read. This
 *  lists the SAME catalog the composer menu reads (`GET /brain/commands`, already surface-filtered by the
 *  daemon) with each command's description, and a row runs the command exactly as picking it from the
 *  composer would. `/help` itself is left out: re-opening the overlay you are reading is not a command. */
export function HelpModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { commands, runSlash } = useBrainChat();
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const needle = filter.trim().replace(/^\//, '').toLowerCase();
    const all = commands.filter((c) => c.name !== 'help');
    if (!needle) return all;
    return all.filter((c) => c.name.toLowerCase().includes(needle) || (c.description ?? '').toLowerCase().includes(needle));
  }, [commands, filter]);

  return (
    <Modal title={t.helpModal.modalTitle} onClose={onClose} size="md" icon={HelpCircle}>
      <ModalBody gap={4}>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t.helpModal.filterPlaceholder}
          aria-label={t.helpModal.filterPlaceholder}
        />

        {rows.length === 0 ? (
          <EmptyState title={t.helpModal.emptyTitle} description={t.helpModal.emptyDesc} icon={HelpCircle} />
        ) : (
          <div className="flex max-h-[26rem] flex-col gap-px overflow-y-auto rounded-md border border-border bg-border/50">
            {rows.map((cmd) => (
              <button
                key={cmd.name}
                type="button"
                onClick={() => { onClose(); runSlash(cmd); }}
                className="flex items-center gap-3 bg-surface px-3 py-2 text-left transition-colors hover:bg-elevated"
              >
                <span className="shrink-0 font-mono text-xs text-text">{`/${cmd.name}`}</span>
                <span className="truncate text-xs text-text-muted" title={cmd.description}>{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
      </ModalBody>
    </Modal>
  );
}
