import { useState } from 'react';
import { Eye, GitFork, Package, Plus, User } from 'lucide-react';
import { runtime, type PluginSubagent, type SaveStatus } from './runtime';
import { AgentModelPinField, useAgentModelPins } from './AgentModelPin';

type ToolsMode = 'read-only' | 'all' | 'inherit' | 'custom';
/** `customTools` is a comma-separated tool list, used only when `toolsMode === 'custom'`. */
type SubagentForm = { editing: string | null; name: string; description: string; body: string; toolsMode: ToolsMode; customTools: string };
const EMPTY_FORM: SubagentForm = { editing: null, name: '', description: '', body: '', toolsMode: 'read-only', customTools: '' };

/** Sub-agents manager (the subagent plugin's own page).
 *
 *  ONE register of agents, and one place per agent. Opening a row opens that agent's detail rail: for a
 *  built-in agent it states what the agent is and carries the only control the reader owns over it — the
 *  model it runs on for THEM; for a custom agent an administrator gets the authoring form there instead.
 *  The models deliberately do not have a panel of their own above the register: that listed the same three
 *  names twice and read as a locked settings block detached from the agents it was about.
 *
 *  Two audiences, one page and one permission model — the host's. Choosing a model is an account setting
 *  and needs no administrator. Authoring agents edits instance-wide definition files, so the create/edit/
 *  delete controls belong to administrators, and the API refuses those writes for everyone else
 *  regardless of what the page draws. Nothing instance-wide — another account's runs, delegation history,
 *  plugin controls — is on this page at all. */
export function SubagentsSettings({ surface }: { surface: 'page' | 'deck' }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings('subagent');
  const { t } = hooks.useTranslation();
  const query = hooks.usePluginSubagents();
  const save = hooks.useSavePluginSubagent();
  const remove = hooks.useDeletePluginSubagent();
  const me = hooks.useMe();
  const canAuthor = me.data?.user?.is_admin === true;
  const pins = useAgentModelPins();
  const [creating, setCreating] = useState(false);

  const toolsLabel = (tools: PluginSubagent['tools']): string =>
    Array.isArray(tools) ? tools.join(', ') : { 'read-only': s.toolsReadOnly, all: s.toolsAll, inherit: s.toolsInherit }[tools];

  // On its own page nothing above this component reports a save any more, so the outcome of the
  // mutations that write is read straight off them. All three are watched: deleting an agent is as
  // much a save as editing one, a failed delete with no indicator looks like nothing happened, and
  // picking an agent's model writes immediately and deserves the same single indicator.
  const saveStatus: SaveStatus = save.isPending || remove.isPending || pins.saving ? 'saving'
    : save.isError || remove.isError || pins.saveError ? 'error'
    : save.isSuccess || remove.isSuccess || pins.saveSuccess ? 'saved'
    : 'idle';

  const agents: PluginSubagent[] = query.data ?? [];
  const userCount = agents.filter((agent) => agent.source === 'user').length;
  const readOnlyCount = agents.filter((agent) => agent.tools === 'read-only').length;

  const addButton = canAuthor
    ? <C.Button variant="accent" icon={Plus} onClick={() => setCreating(true)}>{s.add}</C.Button>
    : undefined;

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
        // A shipped agent's definition is not editable by anyone, but its model IS the reader's, so its
        // row opens a rail that states what the agent is and then lets them set that one thing. A custom
        // agent nobody here may author opens nothing: there would be nothing in it.
        inspect={{
          has: (agent: PluginSubagent) => agent.source === 'builtin',
          render: (agent: PluginSubagent) => (
            <div className="flex min-w-0 flex-col gap-4">
              {/* Read-only identity. The rail's header already carries the agent's name and its
                  one-line description, so this states only what the header cannot: where the agent comes
                  from, what it may touch, and that neither is anyone's to change here. */}
              <C.SettingsGroup title={s.identityTitle} description={s.builtinReadOnly}>
                <C.SettingsRow
                  label={t.assetEditor.colSource}
                  icon={Package}
                  control={<C.Badge tone="default">{s.badgeBuiltin}</C.Badge>}
                />
                <C.SettingsRow
                  label={s.tools}
                  icon={Eye}
                  control={<C.Badge tone="default">{toolsLabel(agent.tools)}</C.Badge>}
                />
              </C.SettingsGroup>
              <AgentModelPinField agent={agent} pins={pins} />
            </div>
          ),
        }}
        renderFieldsBeforeBody={(form: SubagentForm, patch: (p: Partial<SubagentForm>) => void) => (
          <>
            <C.Field label={s.tools} hint={s.toolsHint}>
              <C.SelectMenu
                value={form.toolsMode}
                onChange={(value: ToolsMode) => patch({ toolsMode: value })}
                label={s.tools}
                options={[
                  { value: 'read-only', label: s.toolsReadOnly },
                  { value: 'all', label: s.toolsAll },
                  { value: 'inherit', label: s.toolsInherit },
                  { value: 'custom', label: s.toolsCustom },
                ]}
              />
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

  // In the Settings deck the surrounding panel supplies the page frame; on its own page this section
  // owns the whole surface (see `ownsPageFrame` in index.tsx), so it brings the shell — and, because
  // there is no host masthead above it any more, its own save indicator.
  if (surface === 'deck') return surfaceDocument;
  return (
    <C.WorkspaceShell
      variant="register"
      hero={{
        eyebrow: s.workspaceEyebrow,
        title: s.title,
        count: agents.length,
        description: s.sectionHint,
        icon: GitFork,
        mascot: query.isLoading ? 'saving' : query.isError ? 'error' : 'idle',
        status: saveStatus !== 'idle'
          ? <C.AutoSaveStatus status={saveStatus} />
          : !query.isLoading && !query.isError ? <span className="workspace-status">{s.workspaceReady}</span> : undefined,
        action: addButton,
        metrics: <>
          <C.WorkspaceMetric label={t.assetEditor.filterUser} value={userCount} icon={User} />
          <C.WorkspaceMetric label={t.assetEditor.filterBuiltin} value={agents.length - userCount} icon={Package} />
          <C.WorkspaceMetric label={s.toolsReadOnly} value={readOnlyCount} icon={Eye} />
        </>,
      }}
    >
      {surfaceDocument}
    </C.WorkspaceShell>
  );
}
