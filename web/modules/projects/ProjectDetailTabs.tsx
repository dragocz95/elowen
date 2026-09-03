'use client';

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { PluginProjectPanelProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { Info, UsersRound } from 'lucide-react';
import type { Project } from '../../lib/types';
import type { PluginUiListing } from '../../lib/types';
import { usePluginUi, useProjectMemoryMembers, useProjectUsers, useUsers } from '../../lib/queries';
import { useAssignProject, useSetProjectMemoryMembers, useUpdateProject } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from '../../lib/pluginUi';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
import { SpatialRow } from '../../components/ui/SpatialPrimitives';
import { Toggle } from '../../components/ui/Toggle';
import { Avatar } from '../../components/ui/Avatar';
import { useToast } from '../../components/ui/Toast';

type ProjectRegistration = PluginUiRegistration & {
  project?: Record<string, ComponentType<PluginProjectPanelProps>>;
};
type ProjectPanel = { entry: PluginUiListing; id: string; label: string; icon?: string; tabId: string };

function panelTabId(plugin: string, id: string): string {
  return `plugin:${encodeURIComponent(plugin)}:${encodeURIComponent(id)}`;
}

function PluginProjectPanel({ panel, project }: { panel: ProjectPanel; project: Project }) {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<ProjectRegistration | null | undefined>(undefined);
  const compatible = panel.entry.apiVersion <= PLUGIN_UI_API_VERSION;

  useEffect(() => {
    if (!compatible) return;
    let alive = true;
    void loadPluginUi(panel.entry.name, panel.entry.url, panel.entry.cssUrl).then((value) => {
      if (alive) setRegistration(value);
    });
    return () => { alive = false; };
  }, [compatible, panel.entry.cssUrl, panel.entry.name, panel.entry.url]);

  if (!compatible) return <ErrorState message={t.pluginUi.incompatible} />;
  if (registration === undefined) return <LoadingState variant="list" />;
  if (registration === null) return <ErrorState message={t.pluginUi.loadFailed} />;
  const Component = registration.project?.[panel.id];
  if (!Component) return <ErrorState message={t.pluginUi.settingsUnavailable} />;
  return <Component plugin={panel.entry.name} panelId={panel.id} project={project} surface="project" />;
}

function ProjectAccessPanel({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const users = useUsers();
  const members = useProjectUsers(project.id);
  const assign = useAssignProject();
  const [open, setOpen] = useState(false);

  if (users.isError || members.isError) return <ErrorState message={t.users.loadError} onRetry={() => { void users.refetch(); void members.refetch(); }} />;
  if (users.isLoading || members.isLoading) return <LoadingState variant="list" />;

  const assignable = (users.data ?? []).filter((user) => !user.is_admin);
  const selectedIds = new Set(members.data ?? []);
  const assigned = assignable.filter((user) => selectedIds.has(user.id));
  const items: ManageSelectionItem[] = assignable.map((user) => ({
    id: String(user.id),
    label: user.name || user.username,
    badges: [{ text: `@${user.username}`, tone: 'muted' }],
    group: 'members',
    groupLabel: t.users.member,
    icon: <Avatar user={user} size={18} />,
  }));

  const save = async (next: Set<string>) => {
    const changes = assignable.filter((user) => next.has(String(user.id)) !== selectedIds.has(user.id));
    try {
      await Promise.all(changes.map((user) => assign.mutateAsync({
        userId: user.id,
        projectId: project.id,
        currentlyAssigned: selectedIds.has(user.id),
      })));
    } catch (error) {
      toast(error instanceof Error ? error.message : t.users.updateError, 'error');
      throw error;
    }
  };

  return (
    <div className="py-3">
      {assignable.length === 0 ? <p className="text-xs text-muted-foreground">{t.projects.accessEmpty}</p> : (
        <SelectionSummary
          countText={t.projects.accessCount.replace('{n}', String(assigned.length)).replace('{total}', String(assignable.length))}
          samples={assigned.slice(0, 3).map((user) => ({ label: user.name || user.username, icon: <Avatar user={user} size={16} /> }))}
          moreCount={Math.max(0, assigned.length - 3)}
          onManage={() => setOpen(true)}
          manageLabel={t.managePicker.manage}
        />
      )}
      <ManageSelectionModal
        title={t.projects.accessTitle}
        subtitle={t.projects.accessHint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(assigned.map((user) => String(user.id)))}
        onSave={save}
        saving={assign.isPending}
        countLabel={(count) => t.projects.accessSelected.replace('{n}', String(count))}
      />
    </div>
  );
}

/** Admin control for the project's SHARED MEMORY: a toggle plus, when on, the share list. An empty
 *  share list means every project member shares the pool — the picker exists to narrow it. */
function SharedMemoryPanel({ project }: { project: Project }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const users = useUsers();
  const members = useProjectUsers(project.id);
  const shareList = useProjectMemoryMembers(project.id);
  const updateProject = useUpdateProject();
  const setMembers = useSetProjectMemoryMembers();
  const [open, setOpen] = useState(false);
  const on = project.memoryShared === true;

  if (users.isError || members.isError || shareList.isError) {
    return <ErrorState message={t.users.loadError} onRetry={() => { void users.refetch(); void members.refetch(); void shareList.refetch(); }} />;
  }
  if (users.isLoading || members.isLoading || shareList.isLoading) return <LoadingState variant="list" />;

  const userById = new Map((users.data ?? []).map((user) => [user.id, user]));
  const explicit = shareList.data ?? [];
  // What the picker manages: the explicit share list. With it empty, every project member shares —
  // shown as the effective state so the summary never lies about who the pool is visible to.
  const sharers = explicit.length > 0
    ? explicit.flatMap((id) => (userById.has(id) ? [userById.get(id)!] : []))
    : (members.data ?? []).flatMap((id) => (userById.has(id) ? [userById.get(id)!] : []));
  const items: ManageSelectionItem[] = (members.data ?? []).flatMap((id) => {
    const user = userById.get(id);
    if (!user) return [];
    return [{
      id: String(user.id),
      label: user.name || user.username,
      badges: [{ text: `@${user.username}`, tone: 'muted' }],
      group: 'sharers',
      groupLabel: t.projects.memorySharersGroup,
      icon: <Avatar user={user} size={18} />,
    }];
  });

  const toggle = async (next: boolean) => {
    try {
      await updateProject.mutateAsync({ id: project.id, memoryShared: next });
    } catch (error) {
      toast(error instanceof Error ? error.message : t.users.updateError, 'error');
    }
  };
  const save = async (next: Set<string>) => {
    try {
      await setMembers.mutateAsync({ projectId: project.id, userIds: [...next].map(Number).filter(Number.isSafeInteger) });
      toast(t.projects.memorySaved);
    } catch (error) {
      toast(error instanceof Error ? error.message : t.users.updateError, 'error');
      throw error;
    }
  };

  return (
    <div className="border-t border-border/60 py-3">
      <SpatialRow
        title={t.projects.memorySharedTitle}
        icon={UsersRound}
        description={t.projects.memorySharedDesc}
        control={<Toggle checked={on} onChange={(next) => { void toggle(next); }} label={t.projects.memorySharedTitle} disabled={updateProject.isPending} />}
      />
      {on ? (
        <div className="mt-2">
          {/* Rendered in BOTH states so the picker is always reachable: with an empty share list the
              count text says everyone shares, and managing it is how the list becomes non-empty. */}
          <SelectionSummary
            countText={explicit.length === 0
              ? t.projects.memoryEveryone
              : t.projects.memorySharersCount.replace('{n}', String(sharers.length))}
            samples={sharers.slice(0, 3).map((user) => ({ label: user.name || user.username, icon: <Avatar user={user} size={16} /> }))}
            moreCount={Math.max(0, sharers.length - 3)}
            onManage={() => setOpen(true)}
            manageLabel={t.managePicker.manage}
          />
        </div>
      ) : null}
      <ManageSelectionModal
        title={t.projects.memoryPickTitle}
        subtitle={t.projects.memoryPickHint}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        selected={new Set(explicit.map(String))}
        onSave={save}
        saving={setMembers.isPending}
        countLabel={(count) => t.projects.memorySharersCount.replace('{n}', String(count))}
      />
    </div>
  );
}

export function ProjectDetailTabs({ project, isAdmin, overview }: {
  project: Project;
  isAdmin: boolean;
  overview: ReactNode;
}) {
  const { t, locale } = useTranslation();
  const listing = usePluginUi(locale);
  const panels = useMemo<ProjectPanel[]>(() => (listing.data ?? []).flatMap((entry) =>
    (entry.project ?? []).map((panel) => ({
      entry,
      id: panel.id,
      label: panel.label,
      icon: panel.icon,
      tabId: panelTabId(entry.name, panel.id),
    }))), [listing.data]);
  const [active, setActive] = useState('overview');

  useEffect(() => { setActive('overview'); }, [project.id]);
  useEffect(() => {
    if (active.startsWith('plugin:') && !panels.some((panel) => panel.tabId === active)) setActive('overview');
  }, [active, panels]);

  const selectedPanel = panels.find((panel) => panel.tabId === active);
  const options = [
    { value: 'overview', label: t.projects.tabOverview, icon: Info },
    ...(isAdmin ? [{ value: 'access', label: t.projects.tabAccess, icon: UsersRound }] : []),
    ...panels.map((panel) => ({ value: panel.tabId, label: panel.label, icon: pluginLucideIcon(panel.icon) })),
  ];

  return (
    <div className="min-w-0">
      <div className="min-w-0 border-b border-border/70 py-3">
        <Segmented value={active} onChange={setActive} options={options} variant="line" nowrap aria-label={t.projects.detailSections} className="w-full" />
      </div>
      {active === 'overview' ? overview
        : active === 'access' && isAdmin ? (
          <div>
            <ProjectAccessPanel project={project} />
            <SharedMemoryPanel project={project} />
          </div>
        )
          : selectedPanel ? <PluginProjectPanel panel={selectedPanel} project={project} />
            : null}
    </div>
  );
}
