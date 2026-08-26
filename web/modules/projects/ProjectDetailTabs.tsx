'use client';

import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { PluginProjectPanelProps, PluginUiRegistration } from 'elowen-plugin-ui-kit';
import { Info, UsersRound } from 'lucide-react';
import type { Project } from '../../lib/types';
import type { PluginUiListing } from '../../lib/types';
import { usePluginUi, useProjectUsers, useUsers } from '../../lib/queries';
import { useAssignProject } from '../../lib/mutations';
import { useTranslation } from '../../lib/i18n';
import { PLUGIN_UI_API_VERSION, loadPluginUi } from '../../lib/pluginUi';
import { pluginLucideIcon } from '../../lib/pluginIcons';
import { Segmented } from '../../components/ui/Segmented';
import { LoadingState, ErrorState } from '../../components/ui/states';
import { ManageSelectionModal, type ManageSelectionItem } from '../../components/ui/ManageSelectionModal';
import { SelectionSummary } from '../../components/ui/SelectionSummary';
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
      {assignable.length === 0 ? <p className="text-xs text-text-muted">{t.projects.accessEmpty}</p> : (
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
      <div className="overflow-x-auto border-b border-border/70 py-3">
        <Segmented value={active} onChange={setActive} options={options} variant="line" nowrap aria-label={t.projects.detailSections} className="min-w-max" />
      </div>
      {active === 'overview' ? overview
        : active === 'access' && isAdmin ? <ProjectAccessPanel project={project} />
          : selectedPanel ? <PluginProjectPanel panel={selectedPanel} project={project} />
            : null}
    </div>
  );
}
