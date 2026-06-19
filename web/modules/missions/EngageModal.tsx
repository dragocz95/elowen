'use client';
import { useState } from 'react';
import { Rocket, Layers } from 'lucide-react';
import type { EngageInput } from '../../lib/types';
import { useTasks, useMissions, useConfig } from '../../lib/queries';
import { useEngage } from '../../lib/mutations';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Segmented } from '../../components/ui/Segmented';
import { EmptyState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';

export function EngageModal({ onClose }: { onClose: () => void }) {
  const tasks = useTasks();
  const missions = useMissions();
  const config = useConfig();
  const engage = useEngage();
  const { toast } = useToast();
  const { t } = useTranslation();

  const AUTONOMY: { value: string; label: string; desc: string }[] = [
    { value: 'L0', label: t.missions.autonomyL0, desc: t.missions.autonomyL0Desc },
    { value: 'L1', label: t.missions.autonomyL1, desc: t.missions.autonomyL1Desc },
    { value: 'L2', label: t.missions.autonomyL2, desc: t.missions.autonomyL2Desc },
    { value: 'L3', label: t.missions.autonomyL3, desc: t.missions.autonomyL3Desc },
  ];

  const activeEpics = new Set((missions.data ?? []).map((m) => m.epic_id));
  const epics = (tasks.data ?? []).filter((t) => t.type === 'epic' && !activeEpics.has(t.id));

  const [epicId, setEpicId] = useState('');
  const [autonomy, setAutonomy] = useState(config.data?.defaults?.autonomy ?? 'L3');
  const [maxSessions, setMaxSessions] = useState(config.data?.defaults?.maxSessions ?? 1);

  const submit = () => {
    if (!epicId) return;
    const input: EngageInput = { epicId, autonomy, maxSessions, clearedGuardrails: [] };
    engage.mutate(input, {
      onSuccess: () => { toast(t.missions.engaged.replace('{epicId}', epicId)); onClose(); },
      onError: (e) => toast(String(e), 'error'),
    });
  };

  const autoDesc = AUTONOMY.find((a) => a.value === autonomy)?.desc;

  return (
    <Modal title={t.missions.newMission} onClose={onClose} size="md" icon={Rocket}>
      <ModalBody>
        {epics.length === 0 ? (
          <EmptyState title={t.missions.noEpics} description={t.missions.noEpicsDescription} />
        ) : (
          <>
            <Field label={t.missions.fieldEpic} hint={t.missions.epicHint}>
              <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface p-1">
                {epics.map((e) => {
                  const active = e.id === epicId;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setEpicId(e.id)}
                      className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${active ? 'bg-accent/15 border border-accent' : 'hover:bg-elevated'}`}
                    >
                      <Layers size={15} className={active ? 'text-accent' : 'text-text-muted'} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm text-text">{e.title}</span>
                      <span className="shrink-0 font-mono text-[11px] text-text-muted">{e.id}</span>
                    </button>
                  );
                })}
              </div>
            </Field>

            <Field label={t.missions.fieldAutonomy}>
              <Segmented value={autonomy} onChange={setAutonomy} options={AUTONOMY.map((a) => ({ value: a.value, label: a.label }))} />
            </Field>
            {autoDesc ? <p className="-mt-3 text-xs text-text-muted">{autoDesc}</p> : null}

            <Field label={t.missions.fieldMaxSessions}>
              <Input type="number" min={1} value={maxSessions} onChange={(e) => setMaxSessions(Number(e.target.value))} className="w-28" />
            </Field>
          </>
        )}
      </ModalBody>
      {epics.length > 0 ? (
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="accent" icon={Rocket} disabled={!epicId || engage.isPending} onClick={submit}>{t.missions.engage}</Button>
        </ModalFooter>
      ) : null}
    </Modal>
  );
}
