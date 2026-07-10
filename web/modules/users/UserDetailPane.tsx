'use client';
import { useState } from 'react';
import { FolderGit2, Cpu, Wrench, ShieldCheck } from 'lucide-react';
import { useUserProjects } from '../../lib/queries';
import { useAssignProject, useUpdateUser } from '../../lib/mutations';
import type { Project, User as ElowenUser } from '../../lib/types';
import { allModels } from '../../lib/execPresets';
import { execProvider, type ProviderId } from '../../lib/modelProvider';
import { PROVIDERS, providerMeta } from '../settings/providers';
import { useToast } from '../../components/ui/Toast';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { ModelIcon } from '../../components/ui/ModelIcon';
import { ProjectIcon } from '../../components/ui/ProjectIcon';
import { HelpTip } from '../../components/ui/HelpTip';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { useTranslation } from '../../lib/i18n';
import { localDateTime } from '../../lib/format';
import { ToolPills } from './ToolPills';
import { UserStatsInline } from './UserStatsInline';
import { Surface } from '../../components/ui/Surface';

/** Small provider logo for the modal's group headers/filter chips. */
function ProviderGroupIcon({ provider }: { provider: ProviderId }) {
  const meta = providerMeta(provider);
  if (!meta) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={meta.icon} alt="" width={13} height={13} style={{ objectFit: 'contain' }} className={meta.embedded ? 'logo-adaptive' : undefined} aria-hidden />
  );
}

/** Admin-only: assign a user to projects (the access boundary for non-admins). A compact summary
 *  card on the page; the full pick list lives in the manage modal. */
function ProjectChips({ userId, projects }: { userId: number; projects: Project[] }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const assigned = useUserProjects(userId);
  const assign = useAssignProject();
  const [open, setOpen] = useState(false);
  if (projects.length === 0) return <p className="text-xs italic text-text-muted">—</p>;

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
 *  Summary shows the effective allowance; the manage modal groups the global allow-list by provider. */
function ModelChips({ user, globalExecs, custom }: { user: ElowenUser; globalExecs: string[]; custom: { label: string; exec: string }[] }) {
  const { t } = useTranslation();
  const update = useUpdateUser();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  if (globalExecs.length === 0) return <p className="text-xs italic text-text-muted">—</p>;

  const labelOf = (exec: string) => allModels(custom).find((m) => m.exec === exec)?.label
    ?? (exec.startsWith('elowen:') ? exec.slice(exec.indexOf('/') + 1) : exec);
  const iconNameOf = (exec: string) => (exec.startsWith('elowen:') ? exec.slice(exec.indexOf('/') + 1) : exec);

  // Order execs by the settings' provider order so the modal groups follow the executor picker.
  const providerOrder = (id: ProviderId) => {
    const i = PROVIDERS.findIndex((p) => p.id === id);
    return i === -1 ? PROVIDERS.length : i;
  };
  const sortedExecs = [...globalExecs].sort((a, b) => providerOrder(execProvider(a)) - providerOrder(execProvider(b)));
  const items: ManageSelectionItem[] = sortedExecs.map((exec) => {
    const prov = execProvider(exec);
    return {
      id: exec,
      label: labelOf(exec),
      group: prov,
      groupLabel: providerMeta(prov)?.label ?? prov,
      icon: <ModelIcon name={iconNameOf(exec)} size={14} />,
    };
  });
  const groupIcons = Object.fromEntries(
    [...new Set(sortedExecs.map(execProvider))].map((prov) => [prov, <ProviderGroupIcon key={prov} provider={prov} />]),
  );

  const selected = new Set(user.allowed_execs);
  const allowedInGlobal = sortedExecs.filter((e) => selected.has(e));
  const restricted = allowedInGlobal.length > 0;
  const summarySource = restricted ? allowedInGlobal : sortedExecs;
  const countText = restricted
    ? t.managePicker.modelsCount
        .replace('{n}', String(allowedInGlobal.length))
        .replace('{p}', String(new Set(allowedInGlobal.map(execProvider)).size))
    : t.managePicker.allModelsCount.replace('{n}', String(globalExecs.length));

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
        samples={summarySource.slice(0, 3).map((exec) => ({ label: labelOf(exec), icon: <ModelIcon name={iconNameOf(exec)} size={13} /> }))}
        moreCount={Math.max(0, summarySource.length - 3)}
        onManage={() => setOpen(true)}
        manageLabel={t.managePicker.manage}
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

/** A labeled block within the detail pane. `hint` renders as a hover "?" (HelpTip), not inline text. */
function Block({ icon: Icon, title, hint, children }: { icon: typeof FolderGit2; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
        <Icon size={13} aria-hidden />{title}
        {hint ? <HelpTip align="left">{hint}</HelpTip> : null}
      </span>
      {children}
    </section>
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
  const { t, locale } = useTranslation();
  return (
    <Surface level="panel" padding="lg" radius="md">
      <header className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border pb-4">
        <Avatar user={user} size={52} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-text">{user.name || user.username}</span>
            {user.is_admin ? <Badge tone="accent"><ShieldCheck size={11} className="mr-1" aria-hidden />{t.users.admin}</Badge> : null}
          </span>
          <span className="truncate font-mono text-xs text-text-muted">@{user.username} · {localDateTime(user.created_at, locale, false)}</span>
        </div>
        {/* Overview stats sit inline beside the identity, pushed to the right on wide layouts. */}
        <div className="ml-auto"><UserStatsInline userId={user.id} /></div>
      </header>

      <div className="flex flex-col gap-5">
        <Block icon={FolderGit2} title={t.users.projects}><ProjectChips userId={user.id} projects={projects} /></Block>
        <Block icon={Cpu} title={t.users.allowedModels}><ModelChips user={user} globalExecs={globalExecs} custom={customModels} /></Block>
        <Block icon={Wrench} title={t.users.tools} hint={t.users.toolsHint}><ToolPills userId={user.id} /></Block>
      </div>
    </Surface>
  );
}
