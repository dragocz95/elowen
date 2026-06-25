'use client';
import { useState } from 'react';
import type { Task, CommitFileChange } from '../../lib/types';
import { useTaskChangedFileDiff } from '../../lib/queries';
import { useTranslation } from '../../lib/i18n';
import { fileIcon } from '../../lib/fileIcon';
import { Modal } from '../../components/ui/Modal';
import { PatchView } from '../projects/editor/PatchView';

const baseName = (p: string) => p.split('/').pop() ?? p;
const dirName = (p: string) => { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i + 1) : ''; };

/** A task's FROZEN change list: the files it committed (captured at close), with +/− churn and a
 *  click-through to each file's diff. Reads `task.changed_files` — never the live working tree — so an
 *  old task always shows its own work, not whatever the latest agent is currently doing. */
export function TaskChanges({ task }: { task: Task }) {
  const { t } = useTranslation();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const fileDiff = useTaskChangedFileDiff(task.id, openPath);
  const files: CommitFileChange[] = task.changed_files ?? [];
  if (files.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{t.tasks.changes}</span>
      <ul className="flex flex-col gap-1">
        {files.map((f) => {
          const Icon = fileIcon(f.path);
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setOpenPath(f.path)}
                className="card-interactive flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface p-2.5 text-left"
              >
                <Icon size={15} className="shrink-0 text-text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm" title={f.path}>
                  <span className="text-text-muted">{dirName(f.path)}</span><span className="text-text">{baseName(f.path)}</span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
                  <span className="text-success">+{f.added}</span><span className="text-danger">−{f.deleted}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {openPath ? (
        <Modal title={baseName(openPath)} description={openPath} icon={fileIcon(openPath)} size="lg" onClose={() => setOpenPath(null)}>
          <div className="flex h-full min-h-0 flex-col p-5">
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
              <PatchView diff={fileDiff.data?.diff ?? ''} empty={fileDiff.isLoading ? t.common.loading : t.projects.noChanges} />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
