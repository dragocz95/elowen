'use client';
import { useState } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Toggle } from '../../components/ui/Toggle';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePluginSkills } from '../../lib/queries';
import { useCreatePluginSkill, useUpdatePluginSkill, useDeletePluginSkill } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/elowenClient';
import type { PluginSkill } from '../../lib/types';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Mirrors NAME_RE in plugins/skills/index.mjs (and the daemon's POST validation). */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** `editing` holds the name of the skill being edited (name is then immutable), or null for a new one. */
type FormState = { editing: string | null; name: string; description: string; content: string; disableModelInvocation: boolean };
const EMPTY_FORM: FormState = { editing: null, name: '', description: '', content: '', disableModelInvocation: false };

/** Skills manager (the skills plugin detail): bundled skills ship read-only with the install; user
 *  skills are one .md file each and can be created, edited and deleted here. Changes hot-reload the
 *  plugins, so NEW brain conversations pick them up immediately. The `disable-model-invocation` toggle
 *  hides a skill from progressive disclosure while keeping it reachable via /skill:name. */
export function SkillsEditor() {
  const { t } = useTranslation();
  const { data, isLoading } = usePluginSkills();
  const create = useCreatePluginSkill();
  const update = useUpdatePluginSkill();
  const remove = useDeletePluginSkill();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  if (isLoading || !data) return <LoadingState />;

  const nameValid = form !== null && NAME_RE.test(form.name.trim());
  const savable = form !== null && (form.editing !== null || nameValid) && form.description.trim() !== '' && form.content.trim() !== '';

  const openEdit = (skill: PluginSkill) => setForm({
    editing: skill.name, name: skill.name, description: skill.description,
    content: skill.content ?? '', disableModelInvocation: skill.disableModelInvocation,
  });

  const submit = () => {
    if (!form || !savable) return;
    const onError = (e: unknown) => toast(apiErrorMessage(e), 'error');
    if (form.editing !== null) {
      update.mutate(
        { name: form.editing, patch: { description: form.description.trim(), content: form.content, disableModelInvocation: form.disableModelInvocation } },
        { onSuccess: () => { setForm(null); toast(t.skills.updated); }, onError },
      );
    } else {
      create.mutate(
        { name: form.name.trim(), description: form.description.trim(), content: form.content, disableModelInvocation: form.disableModelInvocation },
        { onSuccess: () => { setForm(null); toast(t.skills.created); }, onError },
      );
    }
  };
  // Quick per-row switch: flip the flag without opening the full editor.
  const toggleInvocation = (skill: PluginSkill, next: boolean) => {
    update.mutate(
      { name: skill.name, patch: { disableModelInvocation: next } },
      { onError: (e) => toast(apiErrorMessage(e), 'error') },
    );
  };
  const confirmDelete = () => {
    if (!pendingDelete) return;
    remove.mutate(pendingDelete, {
      onSuccess: () => toast(t.skills.deleted),
      onError: (e) => toast(apiErrorMessage(e), 'error'),
    });
    setPendingDelete(null);
  };

  const saving = create.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-3">
      {data.length === 0 ? <p className="text-xs italic text-text-muted">{t.skills.empty}</p> : null}
      {data.map((skill) => (
        <div key={`${skill.source}:${skill.name}`} className="flex items-center gap-2 rounded-lg border border-border bg-elevated/40 p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-mono text-sm font-medium text-text">{skill.name}</span>
              <Badge tone={skill.source === 'user' ? 'accent' : 'default'}>
                {skill.source === 'user' ? t.skills.badgeUser : t.skills.badgeBundled}
              </Badge>
              {skill.disableModelInvocation ? <Badge tone="default">{t.skills.manualOnlyBadge}</Badge> : null}
            </span>
            {skill.description ? <p className="text-xs text-text-muted">{skill.description}</p> : null}
          </div>
          {skill.source === 'user' ? (
            <div className="flex items-center gap-2">
              <Toggle
                checked={skill.disableModelInvocation}
                onChange={(next) => toggleInvocation(skill, next)}
                label={t.skills.disableModelInvocation}
                disabled={update.isPending}
              />
              <Button variant="ghost" icon={Pencil} aria-label={t.skills.edit} onClick={() => openEdit(skill)} />
              <Button variant="ghost" icon={Trash2} aria-label={t.skills.remove} onClick={() => setPendingDelete(skill.name)} />
            </div>
          ) : null}
        </div>
      ))}

      {form ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-elevated/40 p-3">
          <div className="@container">
          <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2">
            <Field label={t.skills.name} hint={t.help.skillName}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={form.editing !== null}
                className={`font-mono ${form.editing === null && form.name !== '' && !nameValid ? 'border-danger' : ''}`}
                placeholder="deploy-checklist"
              />
            </Field>
            <Field label={t.skills.description} hint={t.help.skillDescription}>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </Field>
          </div>
          </div>
          <Field label={t.skills.content} hint={t.help.skillContent}>
            <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={8} className={textareaClass} />
          </Field>
          <label className="flex items-center gap-2">
            <Toggle
              checked={form.disableModelInvocation}
              onChange={(next) => setForm({ ...form, disableModelInvocation: next })}
              label={t.skills.disableModelInvocation}
            />
            <span className="flex flex-col">
              <span className="text-sm text-text">{t.skills.disableModelInvocation}</span>
              <span className="text-xs text-text-muted">{t.skills.disableModelInvocationHint}</span>
            </span>
          </label>
          <div className="flex items-center gap-2">
            <Button onClick={submit} disabled={!savable || saving}>{t.skills.save}</Button>
            <Button variant="ghost" onClick={() => setForm(null)}>{t.skills.cancel}</Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" icon={Plus} className="self-start" onClick={() => setForm(EMPTY_FORM)}>
          {t.skills.add}
        </Button>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t.skills.deleteTitle}
        description={pendingDelete ? t.skills.deleteDesc.replace('{name}', pendingDelete) : undefined}
        confirmLabel={t.skills.remove}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}
