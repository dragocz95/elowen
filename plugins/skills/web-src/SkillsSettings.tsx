import { useState } from 'react';
import { Hand, Package, Plus, User } from 'lucide-react';
import { runtime, type PluginSkill, type SkillOwner } from './runtime';

type SkillExtra = { disableModelInvocation: boolean; owner: SkillOwner };
type SkillForm = { editing: string | null; name: string; description: string; body: string } & SkillExtra;
// `owner: null` on a NEW skill means "mine" — the daemon resolves an absent owner to the caller's own
// set. Only an admin can switch the form to the instance set.
const EMPTY_FORM: SkillForm = { editing: null, name: '', description: '', body: '', disableModelInvocation: false, owner: null };

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
  const me = hooks.useMe();
  const myId = me.data?.user?.id ?? null;
  const isAdmin = me.data?.user?.is_admin === true;
  const create = hooks.useCreatePluginSkill();
  const update = hooks.useUpdatePluginSkill();
  const remove = hooks.useDeletePluginSkill();
  const [creating, setCreating] = useState(false);

  // Quick per-row switch: flip the flag without opening the full editor.
  // Which set a write addresses. A skill of MINE is written without an owner (the daemon resolves it to
  // the caller), an instance-wide one explicitly, and — for an admin cleaning up — someone else's by id.
  const targetOwner = (skill: PluginSkill): SkillOwner => (skill.owner === null ? 'instance' : skill.owner);

  const toggleInvocation = (skill: PluginSkill, next: boolean) => {
    update.mutate(
      { name: skill.name, owner: targetOwner(skill), patch: { disableModelInvocation: next } },
      { onError: (e) => toast(utils.apiErrorMessage(e), 'error') },
    );
  };

  const ownerLabel = (skill: PluginSkill): string => {
    if (skill.owner === null) return s.ownerInstance;
    return skill.owner === myId ? s.ownerMine : `#${skill.owner}`;
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
          owner: targetOwner(skill),
        })}
        ownership={{
          header: s.ownerColumn,
          label: ownerLabel,
          scopes: [
            { value: 'mine', label: s.scopeMine, matches: (skill: PluginSkill) => skill.owner !== null && skill.owner === myId },
            { value: 'instance', label: s.scopeInstance, matches: (skill: PluginSkill) => skill.owner === null && skill.source === 'user' },
            { value: 'bundled', label: s.scopeBundled, matches: (skill: PluginSkill) => skill.source === 'bundled' },
          ],
        }}
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
            disabled={update.isPending && update.variables?.name === skill.name && update.variables?.owner === targetOwner(skill)}
          />
        )}
        renderFieldsAfterBody={(form: SkillForm, patch: (p: Partial<SkillForm>) => void) => (
          <>
            {/* Only an admin may write the shared set, and only while creating: moving an existing skill
                between sets is a different operation (two files) than editing one. */}
            {isAdmin && form.editing === null ? (
              <C.Field label={s.scopeFieldLabel} hint={s.scopeFieldHint}>
                <C.Segmented
                  value={form.owner === 'instance' ? 'instance' : 'personal'}
                  onChange={(value: string) => patch({ owner: value === 'instance' ? 'instance' : null })}
                  options={[
                    { value: 'personal', label: s.scopeFieldPersonal },
                    { value: 'instance', label: s.scopeFieldInstance },
                  ]}
                  aria-label={s.scopeFieldLabel}
                  nowrap
                />
              </C.Field>
            ) : null}
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
          </>
        )}
        onSave={(form: SkillForm, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => {
          if (form.editing !== null) {
            update.mutate(
              { name: form.editing, owner: form.owner, patch: { description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation } },
              callbacks,
            );
          } else {
            create.mutate(
              { name: form.name.trim(), description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation, owner: form.owner },
              callbacks,
            );
          }
        }}
        saving={create.isPending || update.isPending}
        onDelete={(skill: PluginSkill, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => remove.mutate({ name: skill.name, owner: targetOwner(skill) }, callbacks)}
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
