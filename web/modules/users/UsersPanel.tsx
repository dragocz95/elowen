'use client';
import { useState } from 'react';
import { Users, UserPlus, Trash2, LogOut } from 'lucide-react';
import { useUsers } from '../../lib/queries';
import { useCreateUser, useDeleteUser, useLogout } from '../../lib/mutations';
import { clearToken } from '../../lib/token';
import { useToast } from '../../components/ui/Toast';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { IconButton } from '../../components/ui/IconButton';
import { Table, THead, TR, TH, TD } from '../../components/ui/Table';
import { LoadingState, ErrorState, EmptyState } from '../../components/ui/states';
import { Section } from '../../components/ui/Section';
import { useTranslation } from '../../lib/i18n';

const fmtDate = (iso: string, locale?: string) => {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function UsersPanel() {
  const users = useUsers();
  const deleteUser = useDeleteUser();
  const createUser = useCreateUser();
  const logout = useLogout();
  const { toast } = useToast();
  const { t, locale } = useTranslation();

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');

  function handleDelete(id: number) {
    deleteUser.mutate(id, {
      onSuccess: () => toast(t.users.userDeleted),
      onError: (err) => toast(String(err), 'error'),
    });
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createUser.mutate(
      { username: newUsername, password: newPassword },
      {
        onSuccess: () => {
          toast(t.users.userCreated);
          setNewUsername('');
          setNewPassword('');
        },
        onError: (err) => toast(String(err), 'error'),
      },
    );
  }

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => {
        clearToken();
        window.location.reload();
      },
      onError: () => {
        // Clear token and reload even if the server call fails.
        clearToken();
        window.location.reload();
      },
    });
  }

  if (users.isLoading) return <LoadingState />;
  if (users.isError) return <ErrorState message={t.users.loadError} onRetry={() => users.refetch()} />;

  const data = users.data ?? [];

  return (
    <div className="flex w-full flex-col gap-6">
      <Section title={t.page.users} icon={Users}>
        {data.length === 0 ? (
          <EmptyState title={t.users.empty} />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>{t.users.fieldUsername}</TH>
                <TH>{t.users.fieldCreated}</TH>
                <TH>{t.users.fieldActions}</TH>
              </TR>
            </THead>
            <tbody>
              {data.map((user) => (
                <TR key={user.id}>
                  <TD>{user.username}</TD>
                  <TD>{fmtDate(user.created_at, locale)}</TD>
                  <TD>
                    <IconButton
                      icon={Trash2}
                      label={t.users.deleteLabel.replace('{username}', user.username)}
                      variant="danger"
                      disabled={data.length <= 1 || deleteUser.isPending}
                      onClick={() => handleDelete(user.id)}
                    />
                  </TD>
                </TR>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title={t.users.addUser} icon={UserPlus}>
        <form onSubmit={handleCreate} className="flex max-w-sm flex-col gap-3">
          <Input type="text" placeholder={t.auth.usernamePlaceholder} value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
          <Input type="password" placeholder={t.auth.passwordPlaceholder} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <div>
            <Button type="submit" variant="accent" icon={UserPlus} disabled={createUser.isPending || !newUsername || !newPassword}>
              {t.users.add}
            </Button>
          </div>
        </form>
      </Section>

      <Section title={t.users.session} icon={LogOut}>
        <Button variant="danger" icon={LogOut} onClick={handleLogout} disabled={logout.isPending}>
          {t.users.logout}
        </Button>
      </Section>
    </div>
  );
}
