'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Play, Trash2 } from 'lucide-react';
import { useBrainChat } from './BrainChatProvider';
import { usePluginSkills } from '../../lib/queries';
import { useDeletePluginSkill } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { useToast } from '../../components/ui/Toast';
import { Input } from '../../components/ui/Input';
import { IconButton } from '../../components/ui/IconButton';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Modal, ModalBody } from '../../components/ui/Modal';
import type { PluginSkill } from '../../lib/types';

/** The web dock's `/skills` overlay — the counterpart of the CLI TUI's skills picker, with the same three
 *  capabilities: filter the loaded skills, push one into the CURRENT conversation as PI's native
 *  `/skill:name` (the daemon expands it to the skill's full instructions), and delete a user skill.
 *  Bundled and instance skills are protected, exactly as in the CLI. */
export function SkillsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { loadSkill } = useBrainChat();
  const skillsQuery = usePluginSkills();
  const deleteSkill = useDeletePluginSkill();
  const [filter, setFilter] = useState('');
  const [pendingDelete, setPendingDelete] = useState<PluginSkill | null>(null);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = skillsQuery.data ?? [];
    if (!needle) return all;
    return all.filter((s) => s.name.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle));
  }, [skillsQuery.data, filter]);

  const runDelete = (skill: PluginSkill): void => {
    setPendingDelete(null);
    deleteSkill.mutate(
      { name: skill.name, owner: skill.owner },
      { onError: (e: Error) => toast(e.message, 'error') },
    );
  };

  return (
    <>
      {/* Browse the loaded skills and push one into the conversation — a bottom sheet on a phone. The
          delete confirmation raised from a row is a level deeper and takes the screen, which is what a
          destructive question should do. */}
      <Modal title={t.skillsModal.modalTitle} onClose={onClose} size="md" icon={BookOpen} intent="inspect">
        <ModalBody gap={4}>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t.skillsModal.filterPlaceholder}
            aria-label={t.skillsModal.filterPlaceholder}
          />

          {skillsQuery.isLoading ? (
            <LoadingState variant="list" />
          ) : skillsQuery.isError ? (
            <ErrorState message={t.common.daemonUnreachable} onRetry={() => skillsQuery.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState title={t.skillsModal.emptyTitle} description={t.skillsModal.emptyDesc} icon={BookOpen} />
          ) : (
            <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border bg-border/50">
              {rows.map((skill) => (
                <div key={`${skill.name}:${skill.owner ?? 'shared'}`} className="flex items-center gap-2 bg-card px-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs text-foreground" title={skill.name}>{`/skill:${skill.name}`}</span>
                    <span className="truncate text-xs text-muted-foreground" title={skill.description}>
                      {[skill.scope ?? skill.source, skill.description].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <IconButton
                    icon={Play}
                    label={t.skillsModal.load}
                    // A skill the resolver is not loading cannot be expanded; offering the button would
                    // send a slash the daemon can only echo back as plain text.
                    disabled={skill.active === false}
                    onClick={() => { loadSkill(skill.name); onClose(); }}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t.common.delete}
                    variant="danger"
                    disabled={!skill.canDelete}
                    onClick={() => setPendingDelete(skill)}
                  />
                </div>
              ))}
            </div>
          )}
        </ModalBody>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.skillsModal.deleteTitle}
        description={pendingDelete ? `/skill:${pendingDelete.name}` : undefined}
        onConfirm={() => { if (pendingDelete) runDelete(pendingDelete); }}
        onClose={() => setPendingDelete(null)}
      />
    </>
  );
}
