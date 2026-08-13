import { useState } from 'react';
import { Eye, Package, Plus, User } from 'lucide-react';
import { runtime, type PluginSubagent } from './runtime';

const selectClass = 'w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent';

type ToolsMode = 'read-only' | 'all' | 'inherit' | 'custom';
/** `customTools` is a comma-separated tool list, used only when `toolsMode === 'custom'`. */
type SubagentForm = { editing: string | null; name: string; description: string; body: string; toolsMode: ToolsMode; customTools: string };
const EMPTY_FORM: SubagentForm = { editing: null, name: '', description: '', body: '', toolsMode: 'read-only', customTools: '' };

/** Sub-agents manager (the subagent plugin's own page): built-in explore/plan ship read-only; user
 *  agents are one `.md` file each (frontmatter name/description/tools + a body prompt) and can be
 *  created, edited and deleted here. A read-only agent gets look-only tools plus read-only shell.
 *  Changes hot-reload the plugins, so new conversations pick them up immediately. */
export function SubagentsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('subagent');
  const { t } = hooks.useTranslation();
  const query = hooks.usePluginSubagents();
  const save = hooks.useSavePluginSubagent();
  const remove = hooks.useDeletePluginSubagent();
  const [creating, setCreating] = useState(false);

  const toolsLabel = (tools: PluginSubagent['tools']): string =>
    Array.isArray(tools) ? tools.join(', ') : { 'read-only': s.toolsReadOnly, all: s.toolsAll, inherit: s.toolsInherit }[tools];

  const agents: PluginSubagent[] = query.data ?? [];
  const userCount = agents.filter((agent) => agent.source === 'user').length;
  const readOnlyCount = agents.filter((agent) => agent.tools === 'read-only').length;

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
          badgeBuiltin: s.badgeBuiltin,
          addTitle: s.add,
          edit: s.edit,
          remove: s.remove,
          save: s.save,
          cancel: s.cancel,
          name: s.name,
          nameHint: s.helpName,
          namePlaceholder: 'reviewer',
          description: s.description,
          descriptionHint: s.helpDescription,
          body: s.body,
          bodyHint: s.helpBody,
          bodyPlaceholder: s.bodyPlaceholder,
          created: s.created,
          updated: s.updated,
          deleted: s.deleted,
          deleteTitle: s.deleteTitle,
          deleteDesc: s.deleteDesc,
        }}
        emptyForm={EMPTY_FORM}
        formFromItem={(agent: PluginSubagent): SubagentForm => ({
          editing: agent.name,
          name: agent.name,
          description: agent.description,
          body: agent.body ?? '',
          toolsMode: Array.isArray(agent.tools) ? 'custom' : agent.tools,
          customTools: Array.isArray(agent.tools) ? agent.tools.join(', ') : '',
        })}
        extraValid={(form: SubagentForm) => form.toolsMode !== 'custom' || form.customTools.trim() !== ''}
        renderBadges={(agent: PluginSubagent) => <C.Badge tone="default">{toolsLabel(agent.tools)}</C.Badge>}
        renderFieldsBeforeBody={(form: SubagentForm, patch: (p: Partial<SubagentForm>) => void) => (
          <>
            <C.Field label={s.tools} hint={s.toolsHint}>
              <select className={selectClass} value={form.toolsMode} onChange={(e) => patch({ toolsMode: e.target.value as ToolsMode })}>
                <option value="read-only">{s.toolsReadOnly}</option>
                <option value="all">{s.toolsAll}</option>
                <option value="inherit">{s.toolsInherit}</option>
                <option value="custom">{s.toolsCustom}</option>
              </select>
            </C.Field>
            {form.toolsMode === 'custom' ? (
              <C.Field label={s.customTools} hint={s.customToolsHint}>
                <C.Input value={form.customTools} onChange={(e: React.ChangeEvent<HTMLInputElement>) => patch({ customTools: e.target.value })} className="font-mono" placeholder="Read, Search, Bash" />
              </C.Field>
            ) : null}
          </>
        )}
        onSave={(form: SubagentForm, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => {
          const tools: PluginSubagent['tools'] = form.toolsMode === 'custom'
            ? form.customTools.split(',').map((v) => v.trim()).filter(Boolean)
            : form.toolsMode;
          save.mutate(
            { name: form.editing ?? form.name.trim(), def: { description: form.description.trim(), tools, body: form.body } },
            callbacks,
          );
        }}
        saving={save.isPending}
        onDelete={(agent: PluginSubagent, callbacks: { onSuccess: () => void; onError: (e: unknown) => void }) => remove.mutate(agent.name, callbacks)}
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
        count: agents.length,
        description: s.sectionHint,
        mascotState: query.isLoading ? 'saving' : query.isError ? 'error' : 'idle',
        status: !query.isLoading && !query.isError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={t.assetEditor.filterUser} value={userCount} icon={User} />
          <C.WorkspaceMetric label={t.assetEditor.filterBuiltin} value={agents.length - userCount} icon={Package} />
          <C.WorkspaceMetric label={s.toolsReadOnly} value={readOnlyCount} icon={Eye} />
        </>,
      }}
    >
      {surfaceDocument}
    </C.SpatialWorkspaceLayout>
  );
}
