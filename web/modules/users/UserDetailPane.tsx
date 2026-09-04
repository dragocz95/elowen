'use client';
import { useState } from 'react';
import { FolderGit2, Cpu, Wrench, ShieldCheck, Puzzle, Pencil } from 'lucide-react';
import { useBrainModels, usePlugins, useUserProjects } from '../../lib/queries';
import { useAssignProject, useUpdateUser } from '../../lib/mutations';
import type { Project, User as ElowenUser } from '../../lib/types';
import { allModels } from '../../lib/execPresets';
import { brainModelId, brainModelLabel, execProvider, type ProviderId } from '../../lib/modelProvider';
import { PROVIDERS, ProviderIcon, providerMeta } from '../settings/providers';
import { useToast } from '../../components/ui/Toast';
import { ElowenApiError } from '../../lib/elowenClient';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { AutoSaveStatus } from '../../components/ui/AutoSaveStatus';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { DetailBlock } from '../../components/ui/DetailBlock';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { brainModelSelection } from '../../components/ui/brainModelSelection';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { useTranslation } from '../../lib/i18n';
import { localDateTime } from '../../lib/format';
import { ToolPills } from './ToolPills';
import { UserStatsInline } from './UserStatsInline';
import { PluginUserPanels } from './PluginUserPanels';

/** Small provider logo for the modal's worker-provider group headers/filter chips. */
function ProviderGroupIcon({ provider }: { provider: ProviderId }) {
  const meta = providerMeta(provider);
  if (!meta) return null;
  return <ProviderIcon meta={meta} size={14} />;
}

/** Admin-only: assign a user to projects (the access boundary for non-admins). A compact summary
 *  card on the page; the full pick list lives in the manage modal. */
function ProjectChips({ userId, projects }: { userId: number; projects: Project[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const assigned = useUserProjects(userId);
  const assign = useAssignProject();
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return <p className="text-xs italic text-muted-foreground">—</p>;

  const assignedIds = new Set(assigned.data ?? []);
  const assignedProjects = projects.filter((p) => assignedIds.has(p.id));
  const items: ManageSelectionItem[] = projects.map((p) => ({
    id: String(p.id),
    label: p.slug,
    group: 'projects',
    groupLabel: t.users.projects,
    icon: <ProjectIcon project={p} size={14} />,
  }));

  // The assignment API toggles one project at a time — diff the sets and fire the individual calls.
  const handleSave = async (next: Set<string>) => {
    const ops = projects
      .filter((p) => next.has(String(p.id)) !== assignedIds.has(p.id))
      .map((p) => assign.mutateAsync({ userId, projectId: p.id, currentlyAssigned: assignedIds.has(p.id) }));
    if (ops.length === 0) return;
    try {
      await Promise.all(ops);
    } catch (e) {
      toast(String(e) || t.users.updateError, 'error');
      throw e;
    }
  };

  return (
    <>
      <SelectionSummary
        countText={t.managePicker.projectsCount
          .replace('{n}', String(assignedProjects.length))
          .replace('{total}', String(projects.length))}
        samples={assignedProjects.slice(0, 3).map((p) => ({ label: p.slug, icon: <ProjectIcon project={p} size={13} /> }))}
        moreCount={Math.max(0, assignedProjects.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
        manageAriaLabel={t.users.manageProjects}
      />
      <ManageSelectionModal
        title={t.users.projects}
        subtitle={t.managePicker.projectsSubtitle}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(assignedProjects.map((p) => String(p.id)))}
        onSave={handleSave}
        saving={assign.isPending}
        countLabel={(n) => t.managePicker.projectsSelected.replace('{n}', String(n))}
      />
    </>
  );
}

/** Admin-only: restrict which models a user may run on tasks. Empty selection → no restriction.
 *  Summary shows the effective allowance; the manage modal groups brain models by their catalog provider
 *  (the shared picker grouping) and worker execs by their executor provider. */
function ModelChips({ user, globalExecs, custom }: { user: ElowenUser; globalExecs: string[]; custom: { label: string; exec: string }[] }) {
  const { t } = useTranslation();
  const update = useUpdateUser();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const brainModels = useBrainModels();

  // Display names come from the catalogs — worker presets first, then the Elowen AI model list — never
  // from splitting the exec at its first slash: a brain model id may itself contain slashes
  // (`elowen:relay/ollama/kimi-k2.7-code`), which that split would truncate into the wrong name. The row
  // id below stays the full exec, so the same model offered by two providers remains two entries.
  const workerModels = allModels(custom);
  const catalogModelOf = (exec: string) => brainModels.data?.find((m) => brainModelId(m) === exec);
  const labelOf = (exec: string) => {
    const catalogModel = catalogModelOf(exec);
    return catalogModel ? brainModelLabel(catalogModel) : workerModels.find((m) => m.exec === exec)?.label ?? exec;
  };
  const iconNameOf = (exec: string) => brainModelLabel(exec, brainModels.data);
  // The compact summary uses the same catalog model name as the grouped rows. Full execs remain the
  // selection keys, so same-named models from different providers are still distinct grants.
  const summaryLabelOf = labelOf;

  // What may be OFFERED is derived, never read straight out of stored config — the same rule the daemon's
  // isOfferableExec applies, so this modal cannot advertise something the PATCH would refuse. Worker execs
  // come from the global allow-list, which is where they legitimately live. A brain model, though, exists
  // only as long as its provider does, so its rows come from the live catalog: deleting a provider leaves
  // its `provider/model` strings behind in `globalExecs`, and reading them from there is exactly why
  // `alibaba/…` stayed listed and selectable after that provider was removed.
  const brainCatalog = brainModels.data ?? [];
  const brainExecs = brainCatalog.map(brainModelId);
  const cliExecs = globalExecs.filter((e) => execProvider(e) !== 'elowen');
  if (cliExecs.length === 0 && brainExecs.length === 0) return <p className="text-xs italic text-muted-foreground">—</p>;

  // Brain rows take the ONE shared picker grouping, so this modal and the Settings role pickers group by
  // the same authoritative `provider`/`providerLabel` and cannot drift. Worker rows keep the executor
  // grouping, under `cli:`-prefixed group keys so a worker provider id can never collide with a configured
  // brain provider id (`providerMeta` would otherwise answer a brain provider literally named `codex`).
  const cliGroup = (prov: ProviderId) => `cli:${prov}`;
  const providerOrder = (id: ProviderId) => {
    const i = PROVIDERS.findIndex((p) => p.id === id);
    return i === -1 ? PROVIDERS.length : i;
  };
  const cliGroups = [...new Set(cliExecs.map(execProvider))].sort((a, b) => providerOrder(a) - providerOrder(b));
  const cliItems: ManageSelectionItem[] = cliGroups.flatMap((prov) => cliExecs
    .filter((e) => execProvider(e) === prov)
    .map((exec) => ({
      id: exec,
      label: labelOf(exec),
      group: cliGroup(prov),
      groupLabel: providerMeta(prov)?.label ?? prov,
      icon: <ModelIcon name={iconNameOf(exec)} size={14} />,
    })));
  const { items: brainItems, groupIcons: brainGroupIcons } = brainModelSelection(brainCatalog, brainModelId);
  const items: ManageSelectionItem[] = [...cliItems, ...brainItems];
  const groupIcons = {
    ...Object.fromEntries(cliGroups.map((prov) => [cliGroup(prov), <ProviderGroupIcon key={prov} provider={prov} />])),
    ...brainGroupIcons,
  };

  const selected = new Set(user.allowed_execs);
  // The summary counts the user's OWN grants, not their intersection with what is currently offered. A
  // grant whose model has since disappeared still restricts this account to nothing else, so folding it out
  // here would report them as unrestricted — a permission surface reading wider than it is. The dead grant
  // simply has no row to click; the PATCH filter drops it the next time the admin saves.
  const grants = user.allowed_execs;
  const restricted = grants.length > 0;
  const summarySource = restricted ? grants : items.map((it) => it.id);
  // {p} counts the DISTINCT provider groups behind the grants, resolved exactly the way the modal
  // displays them — a brain grant through its catalog provider, a CLI grant through its executor
  // provider — so two brain providers never collapse into the embedded brain's single bucket. A dead
  // grant has no displayed group and contributes no provider, while still counting as a model below.
  const groupKeyOf = (exec: string): string | null => {
    const inCatalog = brainCatalog.find((m) => brainModelId(m) === exec);
    if (inCatalog) return inCatalog.provider;
    const prov = execProvider(exec);
    return prov === 'elowen' ? null : cliGroup(prov);
  };
  const providerCount = new Set(grants.map(groupKeyOf).filter((key) => key !== null)).size;
  const countText = restricted
    ? t.managePicker.modelsCount
        .replace('{n}', String(grants.length))
        .replace('{p}', String(providerCount))
    : t.managePicker.allModelsCount.replace('{n}', String(items.length));

  const handleSave = async (next: Set<string>) => {
    try {
      await update.mutateAsync({ id: user.id, patch: { allowed_execs: [...next] } });
      toast(t.users.modelsUpdated);
    } catch (e) {
      toast(String(e) || t.users.updateError, 'error');
      throw e;
    }
  };

  return (
    <>
      <SelectionSummary
        countText={countText}
        samples={summarySource.slice(0, 3).map((exec) => ({ id: exec, label: summaryLabelOf(exec), icon: <ModelIcon name={iconNameOf(exec)} size={13} /> }))}
        moreCount={Math.max(0, summarySource.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
        manageAriaLabel={t.users.manageModels}
      />
      <ManageSelectionModal
        title={t.users.allowedModels}
        subtitle={t.users.allModelsHint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={selected}
        onSave={handleSave}
        saving={update.isPending}
        emptySelectionHint={t.users.allModelsHint}
        countLabel={(n) => t.managePicker.modelsSelected.replace('{n}', String(n))}
        groupIcons={groupIcons}
      />
    </>
  );
}

/** Admin-only: which per-user-granted plugins this user may reach. Deny-by-default — an empty selection
 *  means the user reaches none of them (the inverse of the model list above, where empty means "all"),
 *  which is why the summary counts grants rather than describing an allowance. */
function PluginGrantChips({ user }: { user: ElowenUser }) {
  const { t } = useTranslation();
  const update = useUpdateUser();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const plugins = usePlugins();

  const grantable = (plugins.data ?? []).filter((p) => p.userGrantable && !p.removed);
  if (grantable.length === 0) return <p className="text-xs italic text-muted-foreground">{t.users.grantedPluginsEmpty}</p>;

  const granted = grantable.filter((p) => user.granted_plugins.includes(p.name));
  const items: ManageSelectionItem[] = grantable.map((p) => ({
    id: p.name,
    label: p.name,
    group: 'plugins',
    groupLabel: t.users.grantedPlugins,
    icon: <Puzzle size={14} aria-hidden />,
  }));

  const handleSave = async (next: Set<string>) => {
    try {
      await update.mutateAsync({ id: user.id, patch: { granted_plugins: [...next] } });
      toast(t.users.grantedPluginsUpdated);
    } catch (e) {
      toast(String(e) || t.users.updateError, 'error');
      throw e;
    }
  };

  return (
    <>
      <SelectionSummary
        countText={t.users.grantedPluginsCount
          .replace('{n}', String(granted.length))
          .replace('{total}', String(grantable.length))}
        samples={granted.slice(0, 3).map((p) => ({ label: p.name, icon: <Puzzle size={13} aria-hidden /> }))}
        moreCount={Math.max(0, granted.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
        manageAriaLabel={t.users.managePlugins}
      />
      <ManageSelectionModal
        title={t.users.grantedPlugins}
        subtitle={t.users.grantedPluginsHint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(granted.map((p) => p.name))}
        onSave={handleSave}
        saving={update.isPending}
        countLabel={(n) => t.users.grantedPluginsSelected.replace('{n}', String(n))}
      />
    </>
  );
}

/** The identity line, editable in place. UsersView stops a non-admin before this ever renders and the
 *  daemon 403s the route as well, so the control carries no gate of its own. A username is a login
 *  credential: the daemon answers a collision with a 409 and writes nothing, which is surfaced here as a
 *  named message rather than the generic save error, because it is the one failure an admin can act on. */
function IdentityHeader({ user }: { user: ElowenUser }) {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const update = useUpdateUser();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username);
  const [lastPatch, setLastPatch] = useState<{ name: string; username: string } | null>(null);

  function startEditing() {
    // Seed from the user currently shown, not from whatever a previous edit left behind.
    setName(user.name);
    setUsername(user.username);
    update.reset();
    setLastPatch(null);
    setEditing(true);
  }

  function submit(patch: { name: string; username: string }) {
    setLastPatch(patch);
    update.mutate({ id: user.id, patch }, {
      onSuccess: () => { setEditing(false); toast(t.users.identityUpdated); },
      onError: (e) => toast(e instanceof ElowenApiError && e.status === 409 ? t.users.usernameTaken : String(e) || t.users.updateError, 'error'),
    });
  }

  function save() {
    const nextUsername = username.trim();
    if (!nextUsername) return; // an empty login name is refused by the daemon too; don't even ask
    submit({ name: name.trim(), username: nextUsername });
  }

  if (editing) return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Input aria-label={t.users.fieldName} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.users.fieldName} className="max-w-56" autoFocus />
      <Input aria-label={t.users.fieldUsername} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t.users.fieldUsername} className="max-w-56" />
      <AutoSaveStatus
        status={update.isPending ? 'saving' : update.isError ? 'error' : update.isSuccess ? 'saved' : 'idle'}
        onRetry={() => { if (lastPatch) submit(lastPatch); }}
      />
      <Button onClick={save} disabled={update.isPending || !username.trim()}>{t.common.save}</Button>
      <Button variant="ghost" onClick={() => setEditing(false)} disabled={update.isPending}>{t.common.cancel}</Button>
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="truncate text-base font-semibold text-foreground">{user.name || user.username}</span>
        {user.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
        <button type="button" onClick={startEditing} aria-label={t.users.editIdentity} className="shrink-0 rounded-md p-1 text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground hover:opacity-100">
          <Pencil size={13} aria-hidden />
        </button>
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">@{user.username} · {localDateTime(user.created_at, locale, false)}</span>
    </div>
  );
}

/** The detail for a selected user: an identity header carrying a compact overview strip (memories /
 *  sessions / top model) beside the name, then full-width admin access controls — projects, allowed
 *  models, and the effective tool set (whose plugin tools toggle on/off per user). */
export function UserDetailPane({ user, projects, globalExecs, customModels }: {
  user: ElowenUser;
  projects: Project[];
  globalExecs: string[];
  customModels: { label: string; exec: string }[];
}) {
  const { t } = useTranslation();
  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border pb-4">
        <Avatar user={user} size={52} />
        <IdentityHeader user={user} />
        {/* Overview stats sit inline beside the identity, pushed to the right on wide layouts. */}
        <div className="ml-auto"><UserStatsInline userId={user.id} /></div>
      </header>

      <div className="flex flex-col gap-5">
        <DetailBlock icon={FolderGit2} title={t.users.projects}><ProjectChips userId={user.id} projects={projects} /></DetailBlock>
        <DetailBlock icon={Cpu} title={t.users.allowedModels}><ModelChips user={user} globalExecs={globalExecs} custom={customModels} /></DetailBlock>
        <DetailBlock icon={Puzzle} title={t.users.grantedPlugins} hint={t.users.grantedPluginsHint}><PluginGrantChips user={user} /></DetailBlock>
        <DetailBlock icon={Wrench} title={t.users.tools} hint={t.users.toolsHint}><ToolPills user={user} /></DetailBlock>
        <PluginUserPanels user={user} />
      </div>
    </div>
  );
}
