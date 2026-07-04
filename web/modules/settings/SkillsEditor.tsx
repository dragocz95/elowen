'use client';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { LoadingState } from '../../components/ui/states';
import { useToast } from '../../components/ui/Toast';
import { useTranslation } from '../../lib/i18n';
import { usePluginSkills } from '../../lib/queries';
import { useCreatePluginSkill, useDeletePluginSkill } from '../../lib/mutations';
import { apiErrorMessage } from '../../lib/orcaClient';

const textareaClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent';

/** Mirrors NAME_RE in plugins/skills/index.mjs (and the daemon's POST validation). */
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const EMPTY_FORM = { name: '', description: '', content: '' };

/** Skills manager (the skills plugin detail): bundled skills ship read-only with the install; user
 *  skills are one .md file each and can be created and deleted here. Changes hot-reload the plugins,
 *  so NEW brain conversations pick them up immediately. */
export function SkillsEditor() {
  const { t } = useTranslation();
  const { data, isLoading } = usePluginSkills();
  const create = useCreatePluginSkill();
  const remove = useDeletePluginSkill();
  const { toast } = useToast();
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  if (isLoading || !data) return <LoadingState />;

  const nameValid = form !== null && NAME_RE.test(form.name.trim());
  const savable = form !== null && nameValid && form.description.trim() !== '' && form.content.trim() !== '';

  const submit = () => {
    if (!form || !savable) return;
    create.mutate(
      { name: form.name.trim(), description: form.description.trim(), content: form.content },
      {
        onSuccess: () => { setForm(null); toast(t.skills.created); },
        onError: (e) => toast(apiErrorMessage(e), 'error'),
      },
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
            </span>
            {skill.description ? <p className="text-xs text-text-muted">{skill.description}</p> : null}
          </div>
          {skill.source === 'user' ? (
            <Button variant="ghost" icon={Trash2} aria-label={t.skills.remove} onClick={() => setPendingDelete(skill.name)} />
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
                className={`font-mono ${form.name !== '' && !nameValid ? 'border-danger' : ''}`}
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
          <div className="flex items-center gap-2">
            <Button onClick={submit} disabled={!savable || create.isPending}>{t.skills.save}</Button>
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
