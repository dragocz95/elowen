import { GraduationCap } from 'lucide-react';
import { runtime, type PluginSkill } from './runtime';

type SkillExtra = { disableModelInvocation: boolean };
type SkillForm = { editing: string | null; name: string; description: string; body: string } & SkillExtra;
const EMPTY_FORM: SkillForm = { editing: null, name: '', description: '', body: '', disableModelInvocation: false };

/** Skills manager (the skills plugin's settings-deck section): bundled skills ship read-only with the
 *  install; user skills are one .md file each and can be created, edited and deleted here. Changes
 *  hot-reload the plugins, so NEW brain conversations pick them up immediately. The
 *  `disable-model-invocation` toggle hides a skill from progressive disclosure while keeping it
 *  reachable via /skill:name. */
export function SkillsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('skills');
  const { toast } = hooks.useToast();
  const query = hooks.usePluginSkills();
  const create = hooks.useCreatePluginSkill();
  const update = hooks.useUpdatePluginSkill();
  const remove = hooks.useDeletePluginSkill();

  // Quick per-row switch: flip the flag without opening the full editor.
  const toggleInvocation = (skill: PluginSkill, next: boolean) => {
    update.mutate(
      { name: skill.name, patch: { disableModelInvocation: next } },
      { onError: (e) => toast(utils.apiErrorMessage(e), 'error') },
    );
  };

  return (
    <C.PluginSection surface={surface} className="plugin-card" icon={GraduationCap} title={s.title} description={s.sectionHint}>
      <div className="settings-group__panel">
        <C.MarkdownAssetEditor
          query={query}
          labels={{
            empty: s.empty,
            badgeUser: s.badgeUser,
            badgeBuiltin: s.badgeBundled,
            add: s.add,
            edit: s.edit,
            remove: s.remove,
            save: s.save,
            cancel: s.cancel,
            name: s.name,
            nameHint: s.helpName,
            namePlaceholder: 'deploy-checklist',
            description: s.description,
            descriptionHint: s.helpDescription,
            body: s.content,
            bodyHint: s.helpContent,
            created: s.created,
            updated: s.updated,
            deleted: s.deleted,
            deleteTitle: s.deleteTitle,
            deleteDesc: s.deleteDesc,
          }}
          emptyForm={EMPTY_FORM}
          formFromItem={(skill: PluginSkill): SkillForm => ({
            editing: skill.name,
            name: skill.name,
            description: skill.description,
            body: skill.content ?? '',
            disableModelInvocation: skill.disableModelInvocation,
          })}
          renderBadges={(skill: PluginSkill) => (
            <>
              {skill.version != null ? <C.Badge tone="default">v{skill.version}</C.Badge> : null}
              {skill.disableModelInvocation ? <C.Badge tone="default">{s.manualOnlyBadge}</C.Badge> : null}
            </>
          )}
          renderRowControl={(skill: PluginSkill) => (
            <C.Toggle
              checked={skill.disableModelInvocation}
              onChange={(next: boolean) => toggleInvocation(skill, next)}
              label={s.disableModelInvocation}
              disabled={update.isPending && update.variables?.name === skill.name}
            />
          )}
          renderFieldsAfterBody={(form: SkillForm, patch: (p: Partial<SkillForm>) => void) => (
            <label className="flex items-center gap-2">
              <C.Toggle
                checked={form.disableModelInvocation}
                onChange={(next: boolean) => patch({ disableModelInvocation: next })}
                label={s.disableModelInvocation}
              />
              <span className="flex flex-col">
                <span className="text-sm text-text">{s.disableModelInvocation}</span>
                <span className="text-xs text-text-muted">{s.disableModelInvocationHint}</span>
              </span>
            </label>
          )}
          onSave={(form: SkillForm, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => {
            if (form.editing !== null) {
              update.mutate(
                { name: form.editing, patch: { description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation } },
                callbacks,
              );
            } else {
              create.mutate(
                { name: form.name.trim(), description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation },
                callbacks,
              );
            }
          }}
          saving={create.isPending || update.isPending}
          onDelete={(name: string, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => remove.mutate(name, callbacks)}
        />
      </div>
    </C.PluginSection>
  );
}
