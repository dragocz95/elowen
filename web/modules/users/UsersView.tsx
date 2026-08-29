'use client';
import { useDeferredValue, useMemo, useState } from 'react';
import { Users, UserPlus, Trash2, Shield, ShieldCheck, Lock, LogIn, MoreHorizontal, Search, FolderGit2, Cpu } from 'lucide-react';
import { useUsers, useMe, useProjects, useConfig } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useUpdateUser } from '../../lib/mutations';
import type { User as ElowenUser } from '../../lib/types';
import { impersonateUser } from '../../lib/token';
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
import { DataTable, DataTableCell, DataTableChevronCell, DataTableRow } from '../../components/ui/DataTable';
import { WorkspaceDetailRail, WorkspaceMetric } from '../../components/ui/WorkspacePrimitives';
import { WorkspaceShell } from '../../components/ui/WorkspaceShell';
import { RegisterSearch } from '../../components/ui/RegisterSearch';
import { ControlSurfaceDocument, ControlSurfaceRegister, ControlSurfaceState } from '../../components/ui/ControlSurface';

export function UsersView() {
  const users = useUsers();
  const me = useMe();
  const projects = useProjects();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
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

  function handleRole(user: ElowenUser) {
    updateUser.mutate({ id: user.id, patch: { is_admin: !user.is_admin } }, {
      onSuccess: () => toast(t.users.roleUpdated),
      onError: (err) => toast(String(err) || t.users.updateError, 'error'),
    });
  }

  function handleImpersonate(user: ElowenUser) {
    void impersonateUser(user.id).catch(() => toast(t.users.impersonateError, 'error'));
  }

  const data = useMemo(() => users.data ?? [], [users.data]);
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
      <WorkspaceShell variant="register" hero={{ eyebrow: t.users.workspaceEyebrow, title: t.page.users, description: t.users.workspaceIntro, mascot: 'error' }}>
        <ControlSurfaceDocument>
          <ControlSurfaceState><EmptyState title={t.settings.adminOnly} description={t.settings.adminOnlyDesc} icon={Lock} /></ControlSurfaceState>
        </ControlSurfaceDocument>
      </WorkspaceShell>
    </>
  );

  return (
    <>
      <ModuleHeader title={t.page.users} count={users.data?.length} icon={Users} />
      <WorkspaceShell
        variant="register"
        hero={{
          eyebrow: t.users.workspaceEyebrow,
          title: t.page.users,
          count: data.length,
          description: t.users.workspaceIntro,
          mascot: users.isLoading ? 'saving' : users.isError ? 'error' : 'idle',
          status: !users.isLoading && !users.isError ? <span className="workspace-status">{t.users.workspaceReady}</span> : undefined,
          action: <Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>,
          metrics: <>
            <WorkspaceMetric label={t.users.metricUsers} value={data.length} icon={Users} />
            <WorkspaceMetric label={t.users.metricAdmins} value={adminCount} icon={ShieldCheck} />
            <WorkspaceMetric label={t.users.projects} value={projects.data?.length ?? 0} icon={FolderGit2} />
            <WorkspaceMetric label={t.users.allowedModels} value={globalExecs.length} icon={Cpu} />
          </>,
        }}
        // Search-only, and deliberately no `filters`: the directory narrows on one text query and
        // nothing else, so an empty Filters trigger would open a panel with nothing in it.
        toolbar={{
          search: (
            <RegisterSearch
              value={query}
              onChange={setQuery}
              placeholder={t.users.searchPlaceholder}
              label={t.users.searchLabel}
              onClear={() => setQuery('')}
              clearLabel={t.users.searchClear}
            />
          ),
        }}
      >
        <ControlSurfaceDocument>
        {users.isLoading ? <ControlSurfaceState><LoadingState variant="list" /></ControlSurfaceState>
          : users.isError ? <ControlSurfaceState tone="danger"><ErrorState message={t.users.loadError} onRetry={() => users.refetch()} /></ControlSurfaceState>
          : data.length === 0 ? <ControlSurfaceState><EmptyState title={t.users.empty} description={t.users.emptyDescription} icon={Users} action={<Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>} /></ControlSurfaceState>
          : (
            <ControlSurfaceRegister>
            <div className="workspace-master-detail" data-detail={selected != null}>
              <div className="min-w-0">
                {filteredUsers.length === 0 ? <ControlSurfaceState><EmptyState title={t.users.noMatches} icon={Search} /></ControlSurfaceState> : (
                  <DataTable ariaLabel={t.users.tableLabel} columns="minmax(13rem,1.2fr) minmax(10rem,1fr) 8rem 10rem 3rem 1.25rem" compactColumns="minmax(0,1fr) 3rem 1.25rem" data-testid="users-register">
                    <DataTableRow header>
                      <DataTableCell header lines={1}>{t.users.user}</DataTableCell>
                      <DataTableCell header priority="wide" lines={1}>{t.users.username}</DataTableCell>
                      <DataTableCell header priority="wide" lines={1}>{t.users.role}</DataTableCell>
                      <DataTableCell header priority="wide" lines={1}>{t.users.createdAt}</DataTableCell>
                      {/* The chevron track carries no header: its cell is decorative, and the column the
                          row's open control lives in is named by DataTableRow itself. */}
                      <DataTableCell header labelHidden lines={1}>{t.common.actions}</DataTableCell>
                    </DataTableRow>
                    {filteredUsers.map((user) => {
                      const active = selected?.id === user.id;
                      const displayName = user.name || user.username;
                      return (
                        <DataTableRow
                          key={user.id}
                          selected={active}
                          aria-selected={active}
                          className="group cursor-pointer"
                          onOpen={() => setSelectedId(user.id)}
                          openLabel={t.users.openUser.replace('{name}', displayName)}
                          onContextMenu={(event) => openCtxMenu(event, user)}
                        >
                          <DataTableCell lines={1} title={displayName} className="flex items-center gap-3"><Avatar user={user} size={32} /><span className="min-w-0 truncate text-sm font-medium text-foreground group-hover:text-primary">{displayName}</span></DataTableCell>
                          <DataTableCell priority="wide" lines={1} title={`@${user.username}`} className="font-mono text-xs text-muted-foreground">@{user.username}</DataTableCell>
                          <DataTableCell priority="wide" lines={1}>{user.is_admin ? <Badge tone="accent"><ShieldCheck size={10} className="mr-1" aria-hidden />{t.users.admin}</Badge> : <span className="text-xs text-muted-foreground">{t.users.member}</span>}</DataTableCell>
                          <DataTableCell priority="wide" lines={1} className="text-xs text-muted-foreground">{localDateTime(user.created_at, locale, false)}</DataTableCell>
                          <DataTableCell lines="auto" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><ActionMenu label={`${user.username}: ${t.common.actions}`} items={userActions(user)} trigger={<MoreHorizontal size={16} aria-hidden />} triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-60 hover:bg-accent hover:text-foreground group-hover:opacity-100" /></DataTableCell>
                          <DataTableChevronCell />
                        </DataTableRow>
                      );
                    })}
                  </DataTable>
                )}
              </div>
              {selected ? <WorkspaceDetailRail label={t.users.detailTitle} closeLabel={t.common.close} onClose={() => setSelectedId(null)}><UserDetailPane user={selected} projects={projects.data ?? []} globalExecs={globalExecs} customModels={customModels} /></WorkspaceDetailRail> : null}
            </div>
            </ControlSurfaceRegister>
          )}
        </ControlSurfaceDocument>
      </WorkspaceShell>

      {creating && (
        <Modal title={t.users.addUser} onClose={() => setCreating(false)} size="md" icon={UserPlus}>
          <form onSubmit={(e) => { e.preventDefault(); handleCreate(); }} className="flex min-h-0 flex-1 flex-col">
            <ModalBody gap={4}>
              {/* Both are what the submit button below already gates on, so the form states it. */}
              <Field label={t.users.fieldUsername} required>
                {(control) => <Input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder={t.auth.usernamePlaceholder} autoFocus {...control} />}
              </Field>
              <Field label={t.auth.passwordPlaceholder} required>
                {(control) => <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t.auth.passwordPlaceholder} {...control} />}
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
