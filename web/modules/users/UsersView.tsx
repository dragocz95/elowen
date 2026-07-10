'use client';
import { useState } from 'react';
import { Users, UserPlus, Trash2, LogOut, Shield, ShieldCheck, Lock, LogIn, MoreHorizontal } from 'lucide-react';
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
import { EntityList, EntityRow } from '../../components/ui/EntityList';
import { AdaptiveSplit, PageFrame } from '../../components/ui/PageFrame';
import { MotionLayoutItem, MotionPresence } from '../../components/ui/Motion';
import { ActionMenu, type ActionMenuItem } from '../../components/ui/ActionMenu';

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
  // Default the detail pane to the first user once the list loads (nothing selected yet).
  const selected = data.find((u) => u.id === selectedId) ?? data[0] ?? null;

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
      <PageFrame width="wide"><EmptyState title={t.settings.adminOnly} description={t.settings.adminOnlyDesc} icon={Lock} /></PageFrame>
    </>
  );

  return (
    <>
      <ModuleHeader title={t.page.users} count={users.data?.length} icon={Users}>
        <Button variant="ghost" icon={LogOut} onClick={handleLogout} disabled={logout.isPending}>{t.users.logout}</Button>
        <Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>
      </ModuleHeader>

      <PageFrame width="wide">
        {users.isLoading ? <LoadingState variant="list" />
          : users.isError ? <ErrorState message={t.users.loadError} onRetry={() => users.refetch()} />
          : data.length === 0 ? <EmptyState title={t.users.empty} description={t.users.emptyDescription} icon={Users} action={<Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>} />
          : (
            <AdaptiveSplit
              asideWidth="34rem"
              aside={(
                selected ? (
                  <MotionLayoutItem key={`user-detail-${selected.id}`}>
                    <UserDetailPane user={selected} projects={projects.data ?? []} globalExecs={globalExecs} customModels={customModels} />
                  </MotionLayoutItem>
                ) : <MotionLayoutItem key="user-detail-empty"><EmptyState title={t.users.selectUser} description={t.users.selectUserHint} icon={Users} /></MotionLayoutItem>
              )}
            >
              <EntityList data-testid="users-register">
                <MotionPresence>
                  {data.map((user) => {
                    const active = selected?.id === user.id;
                    return (
                      <MotionLayoutItem key={user.id} layoutId={`user-${user.id}`} role="listitem">
                        <EntityRow role="presentation" selected={active} className="group" onContextMenu={(e) => openCtxMenu(e, user)}>
                          <div className="flex min-w-0 items-center gap-2">
                            <button
                              type="button"
                              aria-pressed={active}
                              onClick={() => setSelectedId(user.id)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  setSelectedId(user.id);
                                }
                              }}
                              className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                            >
                              <Avatar user={user} size={36} />
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate text-sm font-medium text-text transition-colors group-hover:text-accent">{user.name || user.username}</span>
                                  {user.is_admin ? <Badge tone="accent"><ShieldCheck size={10} aria-hidden /></Badge> : null}
                                </span>
                                <span className="truncate font-mono text-[11px] text-text-muted">@{user.username} · {localDateTime(user.created_at, locale, false)}</span>
                              </span>
                            </button>
                            <ActionMenu
                              label={`${user.username}: ${t.common.actions}`}
                              items={userActions(user)}
                              trigger={<MoreHorizontal size={16} aria-hidden />}
                              triggerClassName="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                            />
                          </div>
                        </EntityRow>
                      </MotionLayoutItem>
                    );
                  })}
                </MotionPresence>
              </EntityList>
            </AdaptiveSplit>
          )}
      </PageFrame>

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
