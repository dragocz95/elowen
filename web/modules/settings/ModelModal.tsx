'use client';
import { useState } from 'react';
import { Cpu } from 'lucide-react';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { useTranslation } from '../../lib/i18n';
import { type ProviderId, execProvider, execModel, buildExec } from '../../lib/modelProvider';
import { providerMeta } from './providers';

type Choice = ProviderId | 'other';

export function ModelModal({ initial, existingExecs, activeProviders, onClose, onSave }: {
  initial: { label: string; exec: string } | null;
  existingExecs: Set<string>;
  /** Providers configured in the Providers tab — only these are offered when adding a model. */
  activeProviders: ProviderId[];
  onClose: () => void;
  onSave: (m: { label: string; exec: string }) => void;
}) {
  const { t } = useTranslation();
  const editing = !!initial;

  // Offer only configured providers (+ always 'other'). When editing, keep the model's own provider
  // visible even if it was since removed, so the form still represents the saved exec.
  const CHOICES: Choice[] = [
    ...activeProviders,
    ...(initial && !activeProviders.includes(execProvider(initial.exec)) ? [execProvider(initial.exec)] : []),
    'other' as const,
  ];

  const [label, setLabel] = useState(initial?.label ?? '');
  const [provider, setProvider] = useState<Choice>(initial ? execProvider(initial.exec) : (activeProviders[0] ?? 'other'));
  const [model, setModel] = useState(initial ? execModel(initial.exec) : '');
  const [rawExec, setRawExec] = useState(initial?.exec ?? '');

  const previewExec = (provider === 'other' ? rawExec : buildExec(provider, model)).trim();
  const dup = !!previewExec && previewExec !== initial?.exec && existingExecs.has(previewExec);
  const valid = !!label.trim() && !!previewExec && !dup;

  const save = () => { if (valid) onSave({ label: label.trim(), exec: previewExec }); };

  return (
    <Modal title={editing ? t.settings.editModelTitle : t.settings.addModelTitle} onClose={onClose} size="md" icon={Cpu}>
      <ModalBody>
        {/* live preview */}
        <div className="flex items-center gap-3 rounded-lg border border-border bg-elevated/40 p-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-bg">
            <ModelIcon name={previewExec || model} size={24} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-text">{label.trim() || t.settings.addModelTitle}</div>
            <div className="truncate font-mono text-xs text-text-muted">{previewExec || '—'}</div>
          </div>
        </div>

        <Field label={t.settings.labelLabel}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t.settings.modelPlaceholder} autoFocus />
        </Field>

        <Field label={t.settings.fieldProvider} hint={t.settings.providerHint}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {CHOICES.map((id) => {
              const meta = providerMeta(id);
              const active = provider === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setProvider(id)}
                  aria-pressed={active}
                  className={`flex flex-col items-center gap-1.5 rounded-lg border p-2.5 transition-colors ${active ? 'border-accent bg-accent/[0.07]' : 'border-border bg-surface hover:border-border-strong'}`}
                >
                  {meta
                    /* eslint-disable-next-line @next/next/no-img-element */
                    ? <img src={meta.icon} alt="" width={18} height={18} style={{ objectFit: 'contain' }} aria-hidden />
                    : <Cpu size={18} className="text-text-muted" aria-hidden />}
                  <span className="text-[11px] text-text">{meta?.label ?? t.settings.providerOther}</span>
                </button>
              );
            })}
          </div>
        </Field>

        {provider === 'other' ? (
          <Field label={t.settings.execLabel} hint={t.settings.execPlaceholder}>
            <Input value={rawExec} onChange={(e) => setRawExec(e.target.value)} placeholder={t.settings.execPlaceholder} className="font-mono" />
          </Field>
        ) : (
          <Field label={t.settings.fieldModelId} hint={t.settings.modelIdHint}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={t.settings.modelIdPlaceholder} className="font-mono" />
          </Field>
        )}

        {provider !== 'other' && model.trim() ? (
          <p className="-mt-2 text-xs text-text-muted">{t.settings.execResolvesTo} <code className="font-mono text-text">{previewExec}</code></p>
        ) : null}
        {dup ? <p className="-mt-2 text-xs text-danger">{t.settings.execDuplicate}</p> : null}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose}>{t.settings.cancel}</Button>
        <Button variant="accent" disabled={!valid} onClick={save}>{editing ? t.settings.save : t.settings.add}</Button>
      </ModalFooter>
    </Modal>
  );
}
