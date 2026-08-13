import { useState } from 'react';
import { Hand, Package, Plus, User } from 'lucide-react';
import { runtime, type PluginSkill } from './runtime';

type SkillExtra = { disableModelInvocation: boolean };
type SkillForm = { editing: string | null; name: string; description: string; body: string } & SkillExtra;
const EMPTY_FORM: SkillForm = { editing: null, name: '', description: '', body: '', disableModelInvocation: false };

/** Skills manager (the skills plugin's own page): bundled skills ship read-only with the install; user
 *  skills are one .md file each and can be created, edited and deleted here. Changes hot-reload the
 *  plugins, so NEW brain conversations pick them up immediately. The `disable-model-invocation` toggle
 *  hides a skill from progressive disclosure while keeping it reachable via /skill:name. */
export function SkillsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings('skills');
  const { t } = hooks.useTranslation();
  const { toast } = hooks.useToast();
  const query = hooks.usePluginSkills();
  const create = hooks.useCreatePluginSkill();
  const update = hooks.useUpdatePluginSkill();
  const remove = hooks.useDeletePluginSkill();
  const [creating, setCreating] = useState(false);

  // Quick per-row switch: flip the flag without opening the full editor.
  const toggleInvocation = (skill: PluginSkill, next: boolean) => {
    update.mutate(
      { name: skill.name, patch: { disableModelInvocation: next } },
      { onError: (e) => toast(utils.apiErrorMessage(e), 'error') },
    );
  };

  const skills: PluginSkill[] = query.data ?? [];
  const userCount = skills.filter((skill) => skill.source === 'user').length;
  const manualCount = skills.filter((skill) => skill.disableModelInvocation).length;

  const addButton = <C.Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{s.add}</C.Button>;

  const surfaceDocument = (
    <C.ControlSurfaceDocument>
      <C.MarkdownAssetEditor
        query={query}
        creating={creating}
        onCreatingChange={setCreating}
        addAction={surface === 'deck' ? addButton : undefined}
        labels={{
          empty: s.empty,
          badgeUser: s.badgeUser,
          badgeBuiltin: s.badgeBundled,
          addTitle: s.add,
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
    </C.ControlSurfaceDocument>
  );

  // In the Settings deck the surrounding panel supplies the page frame; on its own page the section
  // wears the same spatial workspace every built-in page wears.
  if (surface === 'deck') return surfaceDocument;
  return (
    <C.SpatialWorkspaceLayout
      hero={{
        eyebrow: s.workspaceEyebrow,
        title: s.title,
        count: skills.length,
        description: s.sectionHint,
        mascotState: query.isLoading ? 'saving' : query.isError ? 'error' : 'idle',
        status: !query.isLoading && !query.isError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={t.assetEditor.filterUser} value={userCount} icon={User} />
          <C.WorkspaceMetric label={t.assetEditor.filterBuiltin} value={skills.length - userCount} icon={Package} />
          <C.WorkspaceMetric label={s.manualOnlyBadge} value={manualCount} icon={Hand} />
        </>,
      }}
    >
      {surfaceDocument}
    </C.SpatialWorkspaceLayout>
  );
}
