'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Brain } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { useBrainSessionStatus } from '../../lib/queries';
import { elowenClient } from '../../lib/elowenClient';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { ReasoningScale } from '../../components/ui/ReasoningScale';
import { Toggle } from '../../components/ui/Toggle';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import type { SaveStatus } from '../../lib/useAutoSaveStatus';

/** The web dock's `/reasoning` picker — the counterpart of the CLI TUI's reasoning overlay, and it
 *  carries the same two things that command does: the effort levels the CURRENT model offers (applied
 *  live through POST /brain/think, exactly like the CLI) and the `show` sub-behaviour, which toggles
 *  the transcript's Thought rows. The levels come from the chat's own status row rather than the model
 *  catalog, so the modal reports what the running session actually supports.
 *
 *  The write also moves the account default, so an Account panel open elsewhere is refetched rather
 *  than left showing the value this picker just replaced. */
export function ReasoningModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { activeSessionId, showThoughts, setShowThoughts } = useBrainChat();
  const statusQuery = useBrainSessionStatus(activeSessionId);
  const status = statusQuery.data;
  const levels = status?.thinkingLevels ?? [];
  // The applied level wins over the fetched one until the next read: the write is authoritative and the
  // query is not refetched on every click.
  const [applied, setApplied] = useState<string | null>(null);
  const [statusState, setStatusState] = useState<SaveStatus>('idle');
  const [retryLevel, setRetryLevel] = useState<string | null>(null);
  const current = applied ?? status?.thinkingLevel ?? '';

  const apply = (level: string): void => {
    if (!level || level === current || statusState === 'saving') return;
    const previous = current;
    setRetryLevel(level);
    setApplied(level);
    setStatusState('saving');
    void elowenClient.brainThink(level, activeSessionId ?? undefined)
      .then((r) => {
        setApplied(r.thinkingLevel);
        setStatusState('saved');
        void queryClient.invalidateQueries({ queryKey: ['my-cli-settings'] });
      })
      .catch((e: Error) => { setApplied(previous || null); setStatusState('error'); toast(e.message, 'error'); });
  };

  // `inspect`: two controls, applied live and closed — a phone shows it as a bottom sheet.
  return (
    <Modal title={t.reasoning.modalTitle} onClose={onClose} closeDisabled={statusState === 'saving'} size="md" icon={Brain} intent="inspect">
      <ModalBody gap={4}>
        {statusQuery.isLoading ? (
          <LoadingState variant="list" />
        ) : statusQuery.isError ? (
          <ErrorState message={t.common.daemonUnreachable} onRetry={() => statusQuery.refetch()} />
        ) : levels.length === 0 ? (
          <EmptyState title={t.reasoning.noLevelsTitle} description={t.reasoning.noLevelsDesc} icon={Brain} />
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted px-3 py-3">
            <span className="text-xs font-medium text-muted-foreground">{t.reasoning.effortLabel}</span>
            <ReasoningScale
              options={levels.map((level) => ({ value: level, label: status?.thinkingLevelLabels?.[level] ?? level }))}
              value={current}
              onChange={apply}
              ariaLabel={t.reasoning.effortLabel}
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted px-3 py-2">
          <span className="text-xs text-muted-foreground">{t.reasoning.thoughtRows}</span>
          <Toggle checked={showThoughts} onChange={setShowThoughts} label={t.reasoning.thoughtRows} />
        </div>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={statusState} onRetry={() => { if (retryLevel) apply(retryLevel); }} />} />
    </Modal>
  );
}
