import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { DepPicker } from './DepPicker';
import { runtime } from '../runtime';
import type { Task } from '../types';

const { AutoSaveStatus, Button, Field, Modal, ModalBody, ModalFooter } = runtime().components;
const { useAutoSaveStatus, useTasks, useTranslation, useUpdateTask } = runtime().hooks;
const { elowenClient } = runtime().utils;

/** Edit a task's dependencies in isolation — opened from the task context menu so the user doesn't
 *  have to wade through the full editor just to wire up a blocker. Seeds from the server, then
 *  auto-saves the whole set via the task update patch (the same path the editor uses). */
export function DepPickerModal({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateTask();
  const allTasks = useTasks();
  const [deps, setDeps] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    elowenClient.taskDeps(task.id)
      .then((d) => { if (alive) { setDeps(d); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [task.id]);

  // Auto-save the whole dependency set on change; `loaded` gates it so seeding from the server never saves.
  const { status, retry, flush } = useAutoSaveStatus([deps], async () => { await update.mutateAsync({ id: task.id, patch: { deps } }); }, { ready: loaded });
  const close = () => { flush(); onClose(); };

  const candidates = (allTasks.data ?? []).filter((x) => x.id !== task.id && x.type !== 'epic' && x.status !== 'closed' && x.status !== 'cancelled');
  const toggle = (id: string) => setDeps((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  return (
    <Modal title={t.tasks.depsTitle} description={task.id} onClose={close} size="md" icon={Link2}>
      <ModalBody>
        <Field label={t.tasks.fieldDependsOn} hint={t.help.taskDependsOn}>
          {candidates.length > 0
            ? <DepPicker candidates={candidates} selected={deps} onToggle={toggle} maxHeightClass="max-h-72" />
            : <p className="text-sm text-text-muted">{t.tasks.noMatches}</p>}
        </Field>
      </ModalBody>
      <ModalFooter status={<AutoSaveStatus status={status} onRetry={retry} />}>
        <Button variant="accent" onClick={close}>{t.common.done}</Button>
      </ModalFooter>
    </Modal>
  );
}
