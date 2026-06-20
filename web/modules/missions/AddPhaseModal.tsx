'use client';
import { useState } from 'react';
import { Plus, X, Sparkles, ListChecks, Layers } from 'lucide-react';
import { useConfig } from '../../lib/queries';
import { useInsertPhases } from '../../lib/mutations';
import { allModels } from '../../lib/execPresets';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { IconButton } from '../../components/ui/IconButton';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { taskTypeLabel, TASK_TYPES } from '../tasks/taskMeta';
import { OrcaApiError } from '../../lib/orcaClient';

type Mode = 'manual' | 'replan';
interface ManualPhase { title: string; type: string }

export function AddPhaseModal({ epicId, onClose }: { epicId: string; onClose: () => void }) {
  const { data: config } = useConfig();
  const insert = useInsertPhases();
  const { toast } = useToast();
  const { t } = useTranslation();

  const models = allModels(config?.customModels, config?.hiddenPresets)
    .filter((m) => !config?.allowedExecs || config.allowedExecs.includes(m.exec));

  const [mode, setMode] = useState<Mode>('manual');
  const [exec, setExec] = useState('');
  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<ManualPhase[]>([{ title: '', type: 'task' }]);


  const busy = insert.isPending;

  async function submit() {
    const body = mode === 'manual'
      ? { phases: rows.map((r) => ({ title: r.title.trim(), type: r.type })).filter((r) => r.title) }
      : { goal: goal.trim() };
    if (mode === 'manual' && (!body.phases || body.phases.length === 0)) { toast(t.missions.addPhaseAtLeastOne, 'error'); return; }
    if (mode === 'replan' && !body.goal) { toast(t.missions.addPhaseGoalRequired, 'error'); return; }
    const payload = { ...body, exec: exec || undefined };
    try {
      const r = await insert.mutateAsync({ epicId, body: payload });
      toast(t.missions.addPhaseInserted.replace('{count}', String(r.phases.length)).replace('{s}', r.phases.length === 1 ? '' : 's').replace('{epicId}', epicId));
      onClose();
    } catch (e) {
      if (e instanceof OrcaApiError && e.code === 'autopilot_key_missing') toast(t.tasks.autopilotKeyMissing, 'error');
      else toast(String(e), 'error');
    }
  }

  return (
    <Modal title={t.missions.addPhaseModalTitle.replace('{epic}', epicId)} description={epicId} onClose={onClose} size="md" icon={Layers}>
      <ModalBody>
        <p className="text-xs text-text-muted">{t.missions.addPhaseModalDesc}</p>

        <div className="flex flex-col gap-2">
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as Mode)}
            options={[
              { value: 'manual', label: t.missions.addPhaseModeManual, icon: ListChecks },
              { value: 'replan', label: t.missions.addPhaseModeReplan, icon: Sparkles },
            ]}
          />
          <p className="text-xs text-text-muted">
            {mode === 'manual' ? t.missions.addPhaseManualDesc : t.missions.addPhaseReplanDesc}
          </p>
        </div>

        {mode === 'manual' ? (
          <div className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={row.title}
                  placeholder={t.tasks.phasePlaceholder.replace('{n}', String(i + 1))}
                  onChange={(e) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, title: e.target.value } : r))}
                />
                <Select
                  value={row.type}
                  onChange={(e) => setRows((rs) => rs.map((r, j) => j === i ? { ...r, type: e.target.value } : r))}
                  className="w-32"
                >
                  {TASK_TYPES.filter((taskType) => taskType !== 'epic').map((taskType) => (
                    <option key={taskType} value={taskType}>{taskTypeLabel(t, taskType)}</option>
                  ))}
                </Select>
                <IconButton icon={X} label={t.tasks.removePhase} onClick={() => setRows((rs) => rs.length > 1 ? rs.filter((_, j) => j !== i) : rs)} />
              </div>
            ))}
            <button type="button" onClick={() => setRows((rs) => [...rs, { title: '', type: 'task' }])} className="inline-flex items-center gap-1 self-start text-xs text-accent hover:underline">
              <Plus size={13} aria-hidden /> {t.tasks.addPhase}
            </button>
          </div>
        ) : (
          <Field label={t.missions.addPhaseFieldGoal} hint={t.missions.addPhaseGoalHint}>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t.missions.addPhaseGoalPlaceholder}
              rows={4}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          </Field>
        )}

        <Field label={t.missions.addPhaseFieldExecutor}>
          <Select value={exec} onChange={(e) => setExec(e.target.value)}>
            <option value="">{t.tasks.defaultExecutor}</option>
            {models.map((m) => <option key={m.exec} value={m.exec}>{m.label}</option>)}
          </Select>
        </Field>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
        <Button variant="accent" disabled={busy} onClick={submit}>{t.missions.addPhaseInsert}</Button>
      </ModalFooter>
    </Modal>
  );
}