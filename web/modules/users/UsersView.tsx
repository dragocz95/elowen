'use client';
import { useState } from 'react';
import { Users, UserPlus, Trash2, LogOut, User } from 'lucide-react';
import { useUsers } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useLogout } from '../../lib/mutations';
import { clearToken } from '../../lib/token';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Field } from '../../components/ui/Field';
import { Modal } from '../../components/ui/Modal';
import { ActionMenu } from '../../components/ui/ActionMenu';
import { ModuleHeader } from '../../components/ui/ModuleHeader';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { useTranslation } from '../../lib/i18n';

const fmtDate = (iso: string, locale?: string) => {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const initials = (username: string) => username.trim().slice(0, 2).toUpperCase();

export function UsersView() {
  const users = useUsers();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const logout = useLogout();
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  function handleDelete(id: number) {
    deleteUser.mutate(id, {
      onSuccess: () => toast(t.users.userDeleted),
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
      // Clear token and reload even if the server call fails.
      onError: () => { clearToken(); window.location.reload(); },
    });
  }

  const data = users.data ?? [];

  return (
    <>
      <ModuleHeader title={t.page.users} count={users.data?.length} icon={Users}>
        <Button variant="ghost" icon={LogOut} onClick={handleLogout} disabled={logout.isPending}>{t.users.logout}</Button>
        <Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>
      </ModuleHeader>

      {users.isLoading ? <LoadingState />
        : users.isError ? <ErrorState message={t.users.loadError} onRetry={() => users.refetch()} />
        : data.length === 0 ? <EmptyState title={t.users.empty} description={t.users.emptyDescription} icon={Users} action={<Button variant="accent" icon={UserPlus} onClick={() => setCreating(true)}>{t.users.newUser}</Button>} />
        : (
          <ul className="flex flex-col gap-2.5">
            {data.map((user) => (
              <li
                key={user.id}
                className="card-interactive group flex items-center gap-3.5 rounded-lg border border-border bg-surface p-3.5"
              >
                <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-border bg-elevated">
                  <User size={20} className="text-text-muted group-hover:opacity-0" aria-hidden />
                  <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold text-text opacity-0 group-hover:opacity-100">{initials(user.username)}</span>
                </span>

                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-semibold text-text">{user.username}</span>
                  <span className="truncate font-mono text-xs text-text-muted">{fmtDate(user.created_at, locale)}</span>
                </div>

                <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <ActionMenu
                    label={t.users.deleteLabel.replace('{username}', user.username)}
                    items={[{
                      label: data.length <= 1 ? t.users.lastUserHint : t.users.delete,
                      icon: Trash2,
                      tone: 'danger',
                      onSelect: () => { if (data.length > 1 && !deleteUser.isPending) handleDelete(user.id); },
                    }]}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

      {creating && (
        <Modal title={t.users.addUser} onClose={() => setCreating(false)} size="md">
          <form
            onSubmit={(e) => { e.preventDefault(); handleCreate(); }}
            className="flex flex-col gap-4 p-5"
          >
            <Field label={t.users.fieldUsername}>
              <Input type="text" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder={t.auth.usernamePlaceholder} autoFocus />
            </Field>
            <Field label={t.auth.passwordPlaceholder}>
              <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder={t.auth.passwordPlaceholder} />
            </Field>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>{t.common.cancel}</Button>
              <Button type="submit" variant="accent" icon={UserPlus} disabled={createUser.isPending || !newUsername.trim() || !newPassword}>{t.users.create}</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
