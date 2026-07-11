'use client';
import { useDeferredValue, useMemo, useState } from 'react';
import { Users, UserPlus, Trash2, LogOut, Shield, ShieldCheck, Lock, LogIn, MoreHorizontal, Search, FolderGit2, Cpu } from 'lucide-react';
import { useUsers, useMe, useProjects, useConfig } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useLogout, useUpdateUser } from '../../lib/mutations';
import type { User as ElowenUser } from '../../lib/types';
import { clearToken, impersonateUser } from '../../lib/token';
import { useToast } from '../../components/ui/Toast';
import { Avatar } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal, ModalBody, ModalFooter } from '../../components/ui/Modal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ContextMenu, ContextMenuState, DIVIDER } from '../../components/ui/ContextMenu';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';
import { localDateTime } from '../../lib/format';
import { UserDetailPane } from './UserDetailPane';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';
import { DataTable, DataTableCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceHeader, WorkspaceMetric, WorkspaceMetrics, WorkspacePage } from '../../components/ui/WorkspacePrimitives';

export function UsersView() {
  const users = useUsers();
  const me = useMe();
  const projects = useProjects();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const logout = useLogout();
  const config = useConfig();
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  // Deleting a user is destructive + cascades (settings, memory, personality) — always confirm first.
  const [confirmDelete, setConfirmDelete] = useState<ElowenUser | null>(null);

  function handleDelete(id: number) {
    deleteUser.mutate(id, {
      onSuccess: () => { toast(t.users.userDeleted); setSelectedId((cur) => (cur === id ? null : cur)); },
      onError: (err) => toast(String(err), 'error'),
    });
  }

  function handleCreate() {
    createUser.mutate(
      { username: newUsername, password: newPassword },
      {
        onSuccess: () => {
          toast(t.users.userCreated);
          setCreating(false);
          setNewUsername('');
          setNewPassword('');
        },
        onError: (err) => toast(String(err), 'error'),
      },
    );
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => { clearToken(); window.location.reload(); },
      onError: () => { clearToken(); window.location.reload(); },
    });
  }

  function handleRole(user: ElowenUser) {
    updateUser.mutate({ id: user.id, patch: { is_admin: !user.is_admin } }, {
      onSuccess: () => toast(t.users.roleUpdated),
      onError: (err) => toast(String(err) || t.users.updateError, 'error'),
    });
  }

  function handleImpersonate(user: ElowenUser) {
    void impersonateUser(user.id).catch(() => toast(t.users.impersonateError, 'error'));
  }

  const data = users.data ?? [];
  const isAdmin = me.data?.user?.is_admin ?? false;
  const globalExecs = config.data?.allowedExecs ?? [];
  const customModels = config.data?.customModels ?? [];
  const selected = data.find((u) => u.id === selectedId) ?? null;
  const filteredUsers = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return data.filter((user) => !needle || `${user.name} ${user.username} ${user.email}`.toLowerCase().includes(needle));
  }, [data, deferredQuery]);
  const adminCount = data.filter((user) => user.is_admin).length;

  function userActions(user: ElowenUser): ActionMenuItem[] {
    return [
      ...(isAdmin && user.id !== me.data?.user?.id ? [{
        label: t.users.ctxImpersonate,
        icon: LogIn,
        onSelect: () => handleImpersonate(user),
      }] : []),
      ...(isAdmin ? [{
        label: user.is_admin ? t.users.removeAdmin : t.users.makeAdmin,
        icon: user.is_admin ? Shield : ShieldCheck,
        onSelect: () => { if (!updateUser.isPending) handleRole(user); },
      }] : []),
      ...(data.length > 1 ? [{
        label: t.users.deleteLabel.replace('{username}', user.username),
        icon: Trash2,
        tone: 'danger' as const,
        onSelect: () => setConfirmDelete(user),
      }] : []),
    ];
  }

  function openCtxMenu(e: React.MouseEvent, user: ElowenUser) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(isAdmin && user.id !== me.data?.user?.id ? [{
          label: t.users.ctxImpersonate,
          icon: LogIn,
          onClick: () => handleImpersonate(user),
        }] : []),
        ...(isAdmin ? [{
          label: user.is_admin ? t.users.removeAdmin : t.users.makeAdmin,
          icon: user.is_admin ? Shield : ShieldCheck,
          onClick: () => { if (!updateUser.isPending) handleRole(user); },
        }] : []),
        ...(isAdmin ? [DIVIDER as typeof DIVIDER] : []),
        {
          label: t.users.ctxRemoveAccess,
          icon: Trash2,
          danger: true,
          onClick: () => { if (data.length > 1) setConfirmDelete(user); },
          disabled: data.length <= 1,
        },
      ],
    });
  }

  // Administration surface — admins only. A non-admin who deep-links here gets a clear stop (the
  // daemon also 403s GET /users for them, so there'd be nothing to show anyway).
  if (me.data?.user && !isAdmin) return (
    <>
      <ModuleHeader title={t.page.users} icon={Users} />
      <WorkspacePage>
        <WorkspaceHeader eyebrow={t.users.workspaceEyebrow} title={t.page.users} description={t.users.workspaceIntro} icon={Users} />
        <div className="workspace-content"><EmptyState title={t.settings.adminOnly} description={t.settings.adminOnlyDesc} icon={Lock} /></div>
      </WorkspacePage>
    </>
  );

  return (
    <>
      <ModuleHeader title={t.page.users} count={users.data?.length} icon={Users} />
      <WorkspacePage>
        <WorkspaceHeader
          eyebrow={t.users.workspaceEyebrow}
          title={t.page.users}
          count={data.length}
          description={t.users.workspaceIntro}
          icon={Users}
          status={!users.isLoading && !users.isError ? <span className="workspace-status">{t.users.workspaceReady}</span> : undefined}
          action={<div className="flex items-center gap-3"><button type="button" onClick={handleLogout} disabled={logout.isPending} className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text"><LogOut size={13} aria-hidden />{t.users.logout}</button><Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button></div>}
        />
        <WorkspaceMetrics visual={<div className="users-core"><Users size={28} strokeWidth={1.25} /></div>} ariaLabel={t.users.summary}>
          <WorkspaceMetric label={t.users.metricUsers} value={data.length} icon={Users} />
          <WorkspaceMetric label={t.users.metricAdmins} value={adminCount} icon={ShieldCheck} />
          <WorkspaceMetric label={t.users.projects} value={projects.data?.length ?? 0} icon={FolderGit2} />
          <WorkspaceMetric label={t.users.allowedModels} value={globalExecs.length} icon={Cpu} />
        </WorkspaceMetrics>
        <div className="workspace-content">
        {users.isLoading ? <LoadingState variant="list" />
          : users.isError ? <ErrorState message={t.users.loadError} onRetry={() => users.refetch()} />
          : data.length === 0 ? <EmptyState title={t.users.empty} description={t.users.emptyDescription} icon={Users} action={<Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>} />
          : (
            <div className="workspace-master-detail users-workspace-grid" data-detail={selected != null}>
              <div className="min-w-0">
                <div className="relative border-y border-border/80 py-3">
                  <Search size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                  <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.users.searchPlaceholder} className="pl-9" />
                </div>
                {filteredUsers.length === 0 ? <EmptyState title={t.users.noMatches} icon={Search} /> : (
                  <DataTable ariaLabel={t.users.tableLabel} columns="minmax(13rem,1.2fr) minmax(10rem,1fr) 8rem 10rem 3rem" compactColumns="minmax(0,1fr) 3rem" data-testid="users-register" className="border-t-0">
                    <DataTableRow header>
                      <DataTableCell header>{t.users.user}</DataTableCell>
                      <DataTableCell header priority="wide">{t.users.username}</DataTableCell>
                      <DataTableCell header priority="wide">{t.users.role}</DataTableCell>
                      <DataTableCell header priority="wide">{t.users.createdAt}</DataTableCell>
                      <DataTableCell header><span className="sr-only">{t.common.actions}</span></DataTableCell>
                    </DataTableRow>
                    {filteredUsers.map((user) => {
                      const active = selected?.id === user.id;
                      return (
                        <DataTableRow key={user.id} selected={active} interactive tabIndex={0} aria-selected={active} className="group cursor-pointer" onClick={() => setSelectedId(user.id)} onContextMenu={(event) => openCtxMenu(event, user)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(user.id); } }}>
                          <DataTableCell className="flex items-center gap-3"><Avatar user={user} size={36} /><span className="truncate text-sm font-medium text-text group-hover:text-accent">{user.name || user.username}</span></DataTableCell>
                          <DataTableCell priority="wide" className="truncate font-mono text-xs text-text-muted">@{user.username}</DataTableCell>
                          <DataTableCell priority="wide">{user.is_admin ? <Badge tone="accent"><ShieldCheck size={10} className="mr-1" aria-hidden />{t.users.admin}</Badge> : <span className="text-xs text-text-muted">{t.users.member}</span>}</DataTableCell>
                          <DataTableCell priority="wide" className="text-xs text-text-muted">{localDateTime(user.created_at, locale, false)}</DataTableCell>
                          <DataTableCell onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><ActionMenu label={`${user.username}: ${t.common.actions}`} items={userActions(user)} trigger={<MoreHorizontal size={16} aria-hidden />} triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted opacity-60 hover:bg-elevated hover:text-text group-hover:opacity-100" /></DataTableCell>
                        </DataTableRow>
                      );
                    })}
                  </DataTable>
                )}
              </div>
              {selected ? <WorkspaceDetailRail label={t.users.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}><UserDetailPane user={selected} projects={projects.data ?? []} globalExecs={globalExecs} customModels={customModels} /></WorkspaceDetailRail> : null}
            </div>
          )}
        </div>
      </WorkspacePage>

      {creating && (
        <Modal title={t.users.addUser} onClose={() => setCreating(false)} size="md" icon={UserPlus}>
          <form onSubmit={(e) => { e.preventDefault(); handleCreate(); }} className="flex min-h-0 flex-1 flex-col">
            <ModalBody gap={4}>
              <Field label={t.users.fieldUsername}>
                <Input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder={t.auth.usernamePlaceholder} autoFocus />
              </Field>
              <Field label={t.auth.passwordPlaceholder}>
                <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t.auth.passwordPlaceholder} />
              </Field>
            </ModalBody>
            <ModalFooter>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
              <Button type="submit" variant="accent" icon={UserPlus} disabled={createUser.isPending || !newUsername.trim() || !newPassword}>{t.users.create}</Button>
            </ModalFooter>
          </form>
        </Modal>
      )}
      {ctxMenu && <ContextMenu state={ctxMenu} onClose={() => setCtxMenu(null)} />}

      <ConfirmDialog
        open={!!confirmDelete}
        title={confirmDelete ? t.users.confirmDeleteTitle.replace('{name}', confirmDelete.name || confirmDelete.username) : ''}
        description={t.users.confirmDeleteDesc}
        confirmLabel={t.users.delete}
        onConfirm={() => { if (confirmDelete) handleDelete(confirmDelete.id); setConfirmDelete(null); }}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}
